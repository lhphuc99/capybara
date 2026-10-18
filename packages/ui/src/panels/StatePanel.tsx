import {
  METRO_SDK,
  type Platform,
  type SerializedValue,
  type StateEntryOp,
  type StateEntrySummary,
  type StatePath,
} from '@capybara-devtools/protocol';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { CopyButton } from '../components/CopyButton';
import { DiffView } from '../components/DiffView';
import { EntryTable, Pills } from '../components/EntryTable';
import { JsonTree } from '../components/JsonTree';
import { ResizeHandle, usePaneWidth } from '../components/ResizeHandle';
import { StateTimeline } from '../components/StateTimeline';
import { stateCommand } from '../connection';
import { formatTime, isSpecial, makeMatcher, valueText } from '../format';
import {
  changedPaths,
  diffText,
  entryFilters,
  entryFreshness,
  entryMatches,
  entryPills,
  graftValue,
  groupStores,
  isEntryStore,
  libraryContextCount,
  pathKey,
  pickStore,
  recordLabel,
  recordText,
  storeCount,
  type EntryFilter,
  type StateRecord,
  type StoreChoice,
  type StoreGroup,
  type StoreView,
} from '../state';
import { clearStateTimeline, loadStateEntries, mergeStateStores, type SessionState } from '../store';
import { showToast } from '../toast';

type RecordTab = 'diff' | 'action' | 'state';
type EntryTab = 'data' | 'query';

const CHOICE_KEY = 'capybara:state:store';
/** Up to this many providers of a context under one name, the SDK keeps each one's value in the state. */
const KEYED_PROVIDERS = 20;
const LIBRARY_CONTEXTS_KEY = 'capybara:state:library-contexts';
const ROOT: StatePath = [];

const RECORD_TABS: Record<RecordTab, string> = { diff: 'Diff', action: 'Action', state: 'State' };

const FILTER_LABELS: Record<EntryFilter, string> = {
  all: 'All',
  fetching: 'Fetching',
  stale: 'Stale',
  error: 'Error',
  inactive: 'Inactive',
};

const OP_LABELS: Record<StateEntryOp, string> = {
  refetch: 'Refetch',
  invalidate: 'Invalidate',
  reset: 'Reset',
  cancel: 'Cancel',
  remove: 'Remove',
  revalidate: 'Revalidate',
  clear: 'Clear',
};

const OP_DONE: Record<StateEntryOp, string> = {
  refetch: 'Refetched',
  invalidate: 'Invalidated',
  reset: 'Reset',
  cancel: 'Cancelled',
  remove: 'Removed',
  revalidate: 'Revalidated',
  clear: 'Cleared',
};

const KIND_LABELS: Record<StateEntrySummary['kind'], string> = {
  query: 'Query',
  infinite: 'Infinite query',
  mutation: 'Mutation',
  swr: 'SWR key',
  'swr-infinite': 'SWR infinite key',
  'swr-subscription': 'SWR subscription',
};

export function StatePanel({ session }: { session: SessionState }) {
  return <StateBrowser key={session.meta.info.id} session={session} />;
}

function StateBrowser({ session }: { session: SessionState }) {
  const { info, connected } = session.meta;
  const sessionId = info.id;
  const tracked = info.plugins?.includes('state') ?? false;
  const [choice, setChoice] = useState<StoreChoice | null>(readChoice);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<EntryFilter>('all');
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [recordTab, setRecordTab] = useState<RecordTab>('diff');
  const [entryTab, setEntryTab] = useState<EntryTab>('data');
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [libraryContexts, setLibraryContexts] = useState(readLibraryContexts);
  const layoutRef = useRef<HTMLDivElement>(null);
  const pane = usePaneWidth('capybara:pane:state', 44);

  const groups = useMemo(() => groupStores(session.state, { libraryContexts }), [session.state, libraryContexts]);
  const libraryCount = useMemo(() => libraryContextCount(session.state), [session.state]);
  const store = pickStore(groups, choice, sessionId);
  const storeId = store?.info.id;
  const entryStore = store ? isEntryStore(store) : false;

  // A server that restarted while the app kept running only knows the stores still in the app's replay buffer.
  useEffect(() => {
    if (!connected || !tracked) return;
    let cancelled = false;
    stateCommand(sessionId, 'stores', undefined).then(
      (stores) => {
        if (!cancelled) mergeStateStores(sessionId, stores);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, connected, tracked]);

  // `clear` and the server's trimming drop entry patches, so a cache is read in full whenever it is shown.
  useEffect(() => {
    if (!connected || !storeId || !entryStore) return;
    let cancelled = false;
    stateCommand(sessionId, 'entries', { store: storeId }).then(
      (result) => {
        if (cancelled) return;
        loadStateEntries(sessionId, storeId, result.entries);
        setTotals((current) => ({ ...current, [storeId]: result.total }));
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, connected, storeId, entryStore, store?.resets]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setSelectedSeq(null);
      setSelectedKey(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const matcher = useMemo(() => makeMatcher(query), [query]);
  const records = store?.records;
  const visibleRecords = useMemo(
    () => (records && matcher ? records.filter((record) => matcher.test(recordText(record))) : (records ?? [])),
    [records, matcher],
  );
  const skipped = useMemo(() => records?.reduce((sum, record) => sum + record.skipped, 0) ?? 0, [records]);
  const entryMap = store?.entries;
  const entries = useMemo(() => (entryMap ? [...entryMap.values()] : []), [entryMap]);
  const filters = useMemo(() => entryFilters(entries), [entries]);
  // A chip that went away, e.g. the last stale query refetched, leaves every entry listed.
  const activeFilter = filters.includes(filter) ? filter : 'all';
  const visibleEntries = useMemo(
    () => entries.filter((entry) => entryMatches(entry, activeFilter) && (!matcher || matcher.test(`${entry.label}\n${entry.key}`))),
    [entries, activeFilter, matcher],
  );
  const onSelectRecord = useCallback((seq: number) => setSelectedSeq((current) => (current === seq ? null : seq)), []);
  const onSelectEntry = useCallback((key: string) => setSelectedKey((current) => (current === key ? null : key)), []);

  const toggleLibraryContexts = (show: boolean) => {
    setLibraryContexts(show);
    saveLibraryContexts(show);
  };

  if (!store) return <NoStores session={session} libraryContexts={libraryCount} onShowLibraryContexts={() => toggleLibraryContexts(true)} />;

  const selectStore = (view: StoreView) => {
    const next = { sessionId, id: view.info.id, library: view.info.library, label: view.info.label };
    setChoice(next);
    saveChoice(next);
    if (view.info.id === store.info.id) return;
    setQuery('');
    setFilter('all');
    setSelectedSeq(null);
    setSelectedKey(null);
  };

  // With nothing picked, the newest record is shown, and follows as new ones arrive.
  const shownRecord = (selectedSeq !== null && visibleRecords.find((record) => record.seq === selectedSeq)) || visibleRecords.at(-1);
  const selectedEntry = selectedKey === null ? undefined : store.entries.get(selectedKey);
  const search = (
    <input
      className={`search${matcher?.invalid ? ' invalid' : ''}`}
      placeholder={
        entryStore
          ? store.info.library === 'tanstack-query'
            ? 'Filter query keys'
            : 'Filter keys'
          : store.info.actions
            ? 'Filter actions and paths'
            : 'Filter paths'
      }
      value={query}
      onChange={(event) => setQuery(event.target.value)}
      spellCheck={false}
    />
  );

  return (
    <section className="panel">
      {entryStore ? (
        <div className="toolbar">
          {search}
          <div className="chips">
            {filters.map((id) => (
              <button
                key={id}
                type="button"
                className={`chip${id === 'error' ? ' chip-error' : ''}`}
                aria-pressed={activeFilter === id}
                onClick={() => setFilter(id)}
              >
                {FILTER_LABELS[id]} <span className="n">{entries.filter((entry) => entryMatches(entry, id)).length}</span>
              </button>
            ))}
          </div>
          <span className="spacer" />
          <span className="note">{entriesNote(store, entries, visibleEntries.length, totals[store.info.id])}</span>
        </div>
      ) : (
        <div className="toolbar">
          {search}
          <span className="spacer" />
          <span className="note">
            {visibleRecords.length === store.records.length
              ? `${count(store.records.length, store.info.actions ? 'action' : 'change')}${skipped > 0 ? ` · ${skipped} skipped` : ''}`
              : `${visibleRecords.length} of ${store.records.length}`}
          </span>
          <button type="button" className="btn" onClick={() => clearStateTimeline(sessionId)} disabled={store.records.length === 0}>
            Clear
          </button>
        </div>
      )}

      <div ref={layoutRef} className="state-layout" style={{ '--pane-width': `${pane.width}%` } as CSSProperties}>
        <StoreNav
          groups={groups}
          selected={store}
          onSelect={selectStore}
          libraryContexts={libraryCount > 0 ? { shown: libraryContexts, count: libraryCount, onToggle: toggleLibraryContexts } : undefined}
        />
        {entryStore ? (
          <EntryTable
            key={store.info.id}
            entries={visibleEntries}
            total={entries.length}
            keyTitle={store.info.library === 'tanstack-query' ? 'Query key' : 'Key'}
            selectedKey={selectedKey}
            onSelect={onSelectEntry}
          />
        ) : (
          <StateTimeline
            key={store.info.id}
            records={visibleRecords}
            total={store.records.length}
            actions={store.info.actions}
            selectedSeq={shownRecord?.seq}
            onSelect={onSelectRecord}
          />
        )}
        <aside className="state-detail">
          <ResizeHandle
            container={layoutRef}
            width={pane.width}
            min={25}
            max={65}
            onChange={pane.setWidth}
            onCommit={pane.save}
            onReset={pane.reset}
            label="Resize the details pane"
          />
          {!entryStore ? (
            <RecordDetail
              key={store.info.id}
              sessionId={sessionId}
              store={store}
              record={shownRecord}
              picked={shownRecord !== undefined && shownRecord.seq === selectedSeq}
              connected={connected}
              tab={recordTab}
              onTab={setRecordTab}
            />
          ) : selectedEntry ? (
            <EntryDetail
              key={`${store.info.id}\n${selectedEntry.key}`}
              sessionId={sessionId}
              store={store}
              entry={selectedEntry}
              connected={connected}
              tab={entryTab}
              onTab={setEntryTab}
            />
          ) : (
            <div className="empty small">
              Select {store.info.library === 'tanstack-query' ? 'a query' : 'a key'} to see its data
              {store.info.ops?.length ? ' and act on it' : ''}.
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

function StoreNav({
  groups,
  selected,
  onSelect,
  libraryContexts,
}: {
  groups: StoreGroup[];
  selected: StoreView;
  onSelect: (view: StoreView) => void;
  /** Present while the app has React Contexts of libraries, shown or not. */
  libraryContexts?: { shown: boolean; count: number; onToggle: (show: boolean) => void };
}) {
  return (
    <nav className="state-nav" aria-label="Stores">
      {groups.map((group) => (
        <Fragment key={group.key}>
          <div className="state-group">{group.title}</div>
          {group.stores.map((view) => {
            const total = storeCount(view);
            const sub = storeSubtitle(view);
            return (
              <button
                key={view.info.id}
                type="button"
                className={`state-store${view.info.disposed ? ' disposed' : ''}`}
                aria-selected={view === selected}
                onClick={() => onSelect(view)}
              >
                <span className="state-store-name">
                  <span className={`state-dot ${view.info.library}`} />
                  <span className="state-store-text">
                    <span className="state-store-label" title={view.info.vendor ? `${view.info.label}, from ${view.info.vendor}` : view.info.label}>
                      {view.info.label}
                    </span>
                    {sub && <span className="state-store-sub">{sub}</span>}
                  </span>
                  {view.errors > 0 && <span className="state-alert" title={`${count(view.errors, 'entry', 'entries')} in error`} />}
                </span>
                {view.info.disposed ? (
                  <span className="tag" title="The app no longer uses this store">
                    disposed
                  </span>
                ) : (
                  total > 0 && <span className="state-count">{total}</span>
                )}
              </button>
            );
          })}
        </Fragment>
      ))}
      {libraryContexts && (
        <label className="state-toggle">
          <input type="checkbox" checked={libraryContexts.shown} onChange={(event) => libraryContexts.onToggle(event.target.checked)} />
          Show library contexts <span className="n">{libraryContexts.count}</span>
        </label>
      )}
      {selected.info.note && <p className="adapter-note">{selected.info.note}</p>}
      <p className="adapter-note">
        Missing a Redux store, or a zustand store made with <code>devtools()</code>? <code>init()</code> has to run
        before they load; otherwise use <code>capybaraReduxEnhancer()</code> or <code>watchZustand()</code>.
      </p>
    </nav>
  );
}

/** Under a store's label: the library a context comes from, and how many providers it stands for. */
function storeSubtitle(view: StoreView): string | undefined {
  const { vendor, instances, disposed } = view.info;
  const parts = [vendor, !disposed && instances !== undefined && instances > 1 ? `instances (${instances})` : undefined];
  return parts.filter(Boolean).join(' · ') || undefined;
}

// ---------------------------------------------------------------------------
// Timeline stores
// ---------------------------------------------------------------------------

function RecordDetail({
  sessionId,
  store,
  record,
  picked,
  connected,
  tab,
  onTab,
}: {
  sessionId: string;
  store: StoreView;
  record?: StateRecord;
  /** False while the newest record is shown because none was picked. */
  picked: boolean;
  connected: boolean;
  tab: RecordTab;
  onTab: (tab: RecordTab) => void;
}) {
  const storeId = store.info.id;
  const shown: RecordTab = record ? tab : 'state';
  const read = useCallback((path?: StatePath) => stateCommand(sessionId, 'get', { store: storeId, path }), [sessionId, storeId]);
  const current = useAppValue(
    read,
    shown === 'state' && connected && !store.info.disposed,
    store.records.at(-1)?.seq ?? 0,
    store.lastSkipped,
  );
  const highlight = useMemo(() => (record ? changedPaths(record) : undefined), [record]);
  const title = record ? recordLabel(record).text : store.info.label;

  const copy =
    shown === 'diff' && record
      ? { label: 'Copy the changes as JSON', text: () => diffText(record) }
      : shown === 'action' && record?.action
        ? { label: 'Copy the action as JSON', text: () => valueText(actionValue(record.action!)) }
        : shown === 'state' && current.value !== undefined
          ? { label: 'Copy the state as JSON', text: () => valueText(current.value!) }
          : undefined;

  return (
    <>
      <div className="state-detail-head">
        <span className="state-title" title={title}>
          {title}
        </span>
        <span className="note">{record ? `#${record.rev} · ${formatTime(record.ts)}` : 'current state'}</span>
        <div className="pane-actions">
          <CopyButton className="btn small" label={copy?.label ?? 'Copy'} text={copy?.text ?? (() => '')} disabled={!copy}>
            Copy
          </CopyButton>
        </div>
      </div>
      <div className="state-tabs">
        <div className="subtabs" role="tablist">
          {(record ? (['diff', 'action', 'state'] as const) : (['state'] as const)).map((id) => (
            <button key={id} type="button" role="tab" className="tab" aria-selected={shown === id} onClick={() => onTab(id)}>
              {RECORD_TABS[id]}
            </button>
          ))}
        </div>
      </div>
      <div className="detail-body">
        {shown === 'diff' && record && <DiffView record={record} />}
        {shown === 'action' && record && <ActionView record={record} context={store.info.library === 'context'} />}
        {shown === 'state' && (
          <CurrentState store={store} record={record} picked={picked} connected={connected} current={current} highlight={highlight} />
        )}
      </div>
    </>
  );
}

function ActionView({ record, context }: { record: StateRecord; context: boolean }) {
  if (!record.action) {
    const why =
      record.cause === 'init'
        ? 'The state the store started with; no action made it.'
        : context
          ? "No action: a provider's value changed."
          : 'No action: the app set the state directly.';
    return <p className="note">{why}</p>;
  }
  return <JsonTree value={actionValue(record.action)} expandDepth={2} />;
}

// `payload` is the rest of the action, so spreading it back gives `{type, payload, meta}` instead of `payload.payload`.
function actionValue(action: NonNullable<StateRecord['action']>): SerializedValue {
  const rest = action.payload;
  if (rest === undefined) return { type: action.type };
  if (typeof rest === 'object' && rest !== null && !Array.isArray(rest) && !isSpecial(rest)) {
    return { type: action.type, ...rest };
  }
  return { type: action.type, payload: rest };
}

function CurrentState({
  store,
  record,
  picked,
  connected,
  current,
  highlight,
}: {
  store: StoreView;
  record?: StateRecord;
  picked: boolean;
  connected: boolean;
  current: AppValue<StateRead>;
  highlight?: ReadonlySet<string>;
}) {
  if (store.info.disposed) return <p className="note">The app no longer has this store, so its state cannot be read.</p>;
  if (current.value === undefined || !current.root) {
    if (!connected) return <p className="note">The app is offline. Its state is read live, so reconnect it to see the state.</p>;
    return current.error ? <p className="callout error">{current.error}</p> : <p className="note">Loading…</p>;
  }
  const { rev, pending, truncated } = current.root;
  const instances = store.info.instances ?? 1;
  return (
    <>
      {instances > 1 && (
        <p className="note state-meta">
          {instances} providers of this context are mounted under this name.{' '}
          {instances <= KEYED_PROVIDERS ? 'The state holds the value of each, under its React key.' : 'The state is the value that changed last.'}
        </p>
      )}
      {!connected && <p className="callout">The app is offline. This is the state as it was last read.</p>}
      {current.error && <p className="callout error">{current.error}</p>}
      {truncated && <p className="callout">This state is large, so some branches were cut. Open them to read the rest.</p>}
      <p className="note state-meta">
        {`Current state${rev > 0 ? ` as of #${rev}` : ''}${pending ? ', with newer changes on the way' : ''}.`}
        {record && highlight && highlight.size > 0 && ` Marked: what ${recordLabel(record).text} changed.`}
      </p>
      {/* A picked record opens the tree down to its changes; following the newest keeps what the user opened. */}
      <JsonTree
        key={picked ? record?.seq : 'newest'}
        value={current.value}
        path={ROOT}
        onLoad={current.load}
        highlight={highlight}
        expandDepth={1}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Cache stores
// ---------------------------------------------------------------------------

function EntryDetail({
  sessionId,
  store,
  entry,
  connected,
  tab,
  onTab,
}: {
  sessionId: string;
  store: StoreView;
  entry: StateEntrySummary;
  connected: boolean;
  tab: EntryTab;
  onTab: (tab: EntryTab) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const storeId = store.info.id;
  const disposed = Boolean(store.info.disposed);
  const read = useCallback(
    (path?: StatePath) =>
      stateCommand(sessionId, 'entry', { store: storeId, key: entry.key, path }).then(
        (result) => result && { value: result.data, truncated: result.truncated },
      ),
    [sessionId, storeId, entry.key],
  );
  const data = useAppValue(read, tab === 'data' && connected && !disposed, `${entry.updatedAt}:${entry.status}`, 0);
  // Mutations only report what happened; there is nothing to run again.
  const ops = entry.kind === 'mutation' ? [] : (store.info.ops ?? []);
  const primary = entryPills(entry)[0];

  const act = async (op: StateEntryOp) => {
    const question = confirmation(op, entry.label, store.info.library);
    if (question && !window.confirm(question)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await stateCommand(sessionId, 'act', { store: storeId, key: entry.key, op });
      if (result.done) showToast(OP_DONE[op]);
      else showToast(result.note ?? `${OP_LABELS[op]} did nothing`, 'error');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="state-detail-head">
        <span className="state-title" title={entry.label}>
          {entry.label}
        </span>
        {primary && <Pills pills={[primary]} />}
      </div>
      {ops.length > 0 && (
        <div className="state-detail-head state-ops">
          {ops.map((op) => (
            <button
              key={op}
              type="button"
              className={`btn small${op === 'remove' || op === 'clear' ? ' danger' : ''}`}
              disabled={!connected || disposed || busy || (op === 'cancel' && !entry.fetching)}
              onClick={() => void act(op)}
            >
              {OP_LABELS[op]}
            </button>
          ))}
        </div>
      )}
      <div className="state-tabs">
        <div className="subtabs" role="tablist">
          {(['data', 'query'] as const).map((id) => (
            <button key={id} type="button" role="tab" className="tab" aria-selected={tab === id} onClick={() => onTab(id)}>
              {id === 'data' ? 'Data' : store.info.library === 'tanstack-query' ? 'Query' : 'Entry'}
            </button>
          ))}
        </div>
      </div>
      <div className="detail-body">
        {error && <p className="callout error">{error}</p>}
        {tab === 'data' ? (
          <>
            <EntryData data={data} connected={connected} disposed={disposed} />
            <Facts rows={entryFacts(entry, false)} />
          </>
        ) : (
          <Facts rows={entryFacts(entry, true)} />
        )}
      </div>
    </>
  );
}

function EntryData({ data, connected, disposed }: { data: AppValue<EntryRead>; connected: boolean; disposed: boolean }) {
  if (disposed) return <p className="note">The app no longer has this cache, so its data cannot be read.</p>;
  if (data.value === undefined || !data.root) {
    if (!connected) return <p className="note">The app is offline. Data is read live, so reconnect it to see the data.</p>;
    if (data.root === null) return <p className="note">This entry is no longer in the cache.</p>;
    return data.error ? <p className="callout error">{data.error}</p> : <p className="note">Loading…</p>;
  }
  return (
    <>
      {!connected && <p className="callout">The app is offline. This is the data as it was last read.</p>}
      {data.error && <p className="callout error">{data.error}</p>}
      {data.root.truncated && <p className="callout">This data is large, so some branches were cut. Open them to read the rest.</p>}
      <JsonTree value={data.value} path={ROOT} onLoad={data.load} expandDepth={2} />
    </>
  );
}

function Facts({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="state-kv">
      {rows.map(([name, value]) => (
        <Fragment key={name}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function entryFacts(entry: StateEntrySummary, full: boolean): Array<[string, string]> {
  const updated = entry.updatedAt ? formatTime(entry.updatedAt) : '—';
  const freshness = entryFreshness(entry);
  const rows: Array<[string, string | undefined]> = full
    ? [
        ['Key', entry.key],
        ['Kind', KIND_LABELS[entry.kind] ?? entry.kind],
        ['Status', entry.status],
        ['Fetching', entry.fetching ? 'yes' : entry.paused ? 'paused' : 'no'],
        ['Observers', entry.observers?.toString()],
        ['Active', entry.active === undefined ? undefined : entry.active ? 'yes' : 'no'],
        ['Freshness', freshness],
        ['Disabled', entry.disabled ? 'yes' : undefined],
        ['Updated', updated],
        ['Data', entry.preview],
        ['Error', entry.error],
      ]
    : [
        ['Data updated', updated],
        ['Observers', entry.observers?.toString()],
        ['Freshness', freshness],
        ['Error', entry.error],
      ];
  return rows.filter((row): row is [string, string] => row[1] !== undefined);
}

function entriesNote(store: StoreView, entries: StateEntrySummary[], visible: number, total: number | undefined): string {
  if (visible !== entries.length) return `${visible} of ${entries.length}`;
  const mutations = entries.filter((entry) => entry.kind === 'mutation').length;
  const listed =
    store.info.library === 'tanstack-query'
      ? `${count(entries.length - mutations, 'query', 'queries')} · ${count(mutations, 'mutation')}`
      : count(entries.length, 'key');
  return total !== undefined && total > entries.length ? `${listed} (${total} in the app)` : listed;
}

function confirmation(op: StateEntryOp, label: string, library: StoreView['info']['library']): string | undefined {
  const name = label.length > 80 ? `${label.slice(0, 80)}…` : label;
  switch (op) {
    case 'remove':
      return `Remove ${name} from the cache?`;
    case 'reset':
      // SWR has no initial data to go back to: reset drops the value and fetches again.
      return library === 'swr'
        ? `Reset ${name}? Its cached data is dropped and fetched again.`
        : `Reset ${name}? Its data goes back to its initial value.`;
    case 'clear':
      return `Clear the data cached for ${name}?`;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Reading from the app
// ---------------------------------------------------------------------------

type StateRead = { value: SerializedValue; truncated: boolean; rev: number; pending: boolean };
type EntryRead = { value: SerializedValue; truncated: boolean };

interface Part {
  path: StatePath;
  value: SerializedValue;
}

interface AppValue<T> {
  /** Undefined until the first read; null when the app no longer has the value. */
  root: T | null | undefined;
  /** `root.value` with the parts opened since grafted in. */
  value: SerializedValue | undefined;
  error: string | null;
  load: (path: StatePath) => Promise<void>;
}

/**
 * A value read from the app while `enabled`: again within 250 ms of `version` changing, and at once when `urgent`
 * does, since a reader cannot rebuild what it missed. Parts opened with `load` are read again with it.
 */
function useAppValue<T extends { value: SerializedValue }>(
  read: (path?: StatePath) => Promise<T | null>,
  enabled: boolean,
  version: unknown,
  urgent: unknown,
): AppValue<T> {
  const [reading, setReading] = useState<{ root?: T | null; parts: Part[] }>({ parts: [] });
  const [error, setError] = useState<string | null>(null);
  const partsRef = useRef<Part[]>([]);
  const requestRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);
  const seenRef = useRef({ enabled: false, urgent });

  useEffect(() => {
    partsRef.current = reading.parts;
  }, [reading.parts]);

  const refresh = useCallback(() => {
    const id = ++requestRef.current;
    const opened = partsRef.current;
    const reads = opened.map((part) =>
      read(part.path).then(
        (result): Part | null => result && { path: part.path, value: result.value },
        () => null,
      ),
    );
    Promise.all([read(), ...reads]).then(
      ([root, ...found]) => {
        if (id !== requestRef.current) return;
        const asked = new Set(opened.map((part) => pathKey(part.path)));
        setReading((current) => ({
          root: root as T | null,
          parts: [
            ...(found as Array<Part | null>).filter((part): part is Part => part !== null),
            // Opened while this read was on its way.
            ...current.parts.filter((part) => !asked.has(pathKey(part.path))),
          ],
        }));
        setError(null);
      },
      (reason: Error) => {
        if (id === requestRef.current) setError(reason.message);
      },
    );
  }, [read]);

  useEffect(() => {
    const seen = seenRef.current;
    seenRef.current = { enabled, urgent };
    if (!enabled) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
      return;
    }
    if (!seen.enabled || seen.urgent !== urgent) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
      refresh();
    } else if (timerRef.current === undefined) {
      // Not reset by later changes, so a store that changes all the time is still read every 250 ms.
      timerRef.current = window.setTimeout(() => {
        timerRef.current = undefined;
        refresh();
      }, 250);
    }
  }, [enabled, version, urgent, refresh]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const load = useCallback(
    (path: StatePath) =>
      read(path).then(
        (result) => {
          if (!result) return;
          const key = pathKey(path);
          setReading((current) => ({
            ...current,
            parts: [...current.parts.filter((part) => pathKey(part.path) !== key), { path, value: result.value }],
          }));
        },
        (reason: Error) => setError(reason.message),
      ),
    [read],
  );

  const value = useMemo(() => {
    if (!reading.root) return undefined;
    // Outer parts first, so a part opened inside another lands in it.
    const parts = [...reading.parts].sort((a, b) => a.path.length - b.path.length);
    return parts.reduce((tree, part) => graftValue(tree, part.path, part.value), reading.root.value);
  }, [reading]);

  return { root: reading.root, value, error, load };
}

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

function NoStores({
  session,
  libraryContexts,
  onShowLibraryContexts,
}: {
  session: SessionState;
  /** React Contexts of libraries the list leaves out. */
  libraryContexts: number;
  onShowLibraryContexts: () => void;
}) {
  const { info, connected } = session.meta;
  if (!info.plugins?.includes('state')) {
    if (info.sdk.name === METRO_SDK) {
      return (
        <Empty title="State needs the SDK">
          <p>
            Without the SDK, Capybara reads logs, network and storage through Metro, but not Redux, Zustand, TanStack Query, SWR or
            React Context state. Add it to the app to see its stores:
          </p>
          <Code>{`import { init } from '@capybara-devtools/react-native';\n\nif (__DEV__) init();`}</Code>
        </Empty>
      );
    }
    if (!info.plugins) {
      return (
        <Empty title="Update the SDK to see state">
          <p>
            {info.appName} uses {info.sdk.name} {info.sdk.version}, which does not report Redux, Zustand, TanStack Query, SWR or React
            Context state.
          </p>
          <pre className="code">npm install {info.sdk.name}@latest</pre>
        </Empty>
      );
    }
    return (
      <Empty title="State is turned off">
        <p>
          The app runs {info.sdk.name} {info.sdk.version} without its state plugin. Remove <code>state: false</code> from the
          options passed to <code>init()</code>, or update the SDK if this version came before state.
        </p>
      </Empty>
    );
  }
  if (!connected) {
    return (
      <Empty title="The app is offline">
        <p>State is read live from the app. Its stores show up here once it reconnects.</p>
      </Empty>
    );
  }
  return <Setup platform={info.platform} libraryContexts={libraryContexts} onShowLibraryContexts={onShowLibraryContexts} />;
}

function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <div className="empty">
        <strong>{title}</strong>
        {children}
      </div>
    </section>
  );
}

function Setup({
  platform,
  libraryContexts,
  onShowLibraryContexts,
}: {
  platform: Platform;
  libraryContexts: number;
  onShowLibraryContexts: () => void;
}) {
  const web = platform === 'web';
  const sdk = `'@capybara-devtools/${web ? 'web' : 'react-native'}'`;
  // React Native apps usually give SWRConfig a provider of their own, whose cache watchSWR(SWRConfig) does not see.
  const watches = web
    ? `import { watchQueryClient, watchSWR, watchZustand }
  from ${sdk};
import { SWRConfig } from 'swr';

watchQueryClient(queryClient);
watchSWR(SWRConfig);
watchZustand(useCartStore, { name: 'cart' });`
    : `import {
  swrMiddleware, watchQueryClient, watchZustand,
} from ${sdk};
import { SWRConfig } from 'swr';

watchQueryClient(queryClient);
watchZustand(useCartStore, { name: 'cart' });

<SWRConfig value={{ provider: () => new Map(),
  use: [swrMiddleware] }}>`;
  return (
    <section className="panel">
      <div className="empty state-empty">
        <strong>No state stores yet</strong>
        <p>
          Redux, Zustand, TanStack Query, SWR and React Context show up here once the app registers them.
          <br />
          Keep <code>init()</code> in the first file your app imports,{' '}
          {web ? 'before your store modules and react-dom load.' : 'before your store modules load.'}
        </p>
        {libraryContexts > 0 && (
          <p>
            {libraryContexts === 1 ? 'One React Context comes from a library and is' : `${libraryContexts} React Contexts come from libraries and are`}{' '}
            hidden.{' '}
            <button type="button" className="btn small" onClick={onShowLibraryContexts}>
              Show library contexts
            </button>
          </p>
        )}
        <div className="state-snippets">
          <div>
            <h4>Picked up on their own</h4>
            <Code>
              {`// capybara.ts, the first import of ${web ? 'main.tsx' : 'index.ts'}
import { init } from ${sdk};

if (${web ? 'import.meta.env.DEV' : '__DEV__'}) init();

// Redux Toolkit configureStore(), zustand
// devtools() and React Context providers
// need nothing else.`}
            </Code>
          </div>
          <div>
            <h4>One line each</h4>
            <Code>{watches}</Code>
          </div>
        </div>
      </div>
    </section>
  );
}

// `import.meta` is not the import keyword.
const SYNTAX = /(\/\/.*$)|('[^']*')|\b(import|from|if)\b(?!\.)/gm;

/** A short snippet with comments, strings and keywords colored. */
function Code({ children: code }: { children: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of code.matchAll(SYNTAX)) {
    parts.push(code.slice(last, match.index));
    const className = match[1] ? 'code-comment' : match[2] ? 'code-string' : 'code-keyword';
    parts.push(
      <span key={match.index} className={className}>
        {match[0]}
      </span>,
    );
    last = match.index + match[0].length;
  }
  parts.push(code.slice(last));
  return <pre className="code left">{parts}</pre>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function readLibraryContexts(): boolean {
  try {
    return localStorage.getItem(LIBRARY_CONTEXTS_KEY) === '1';
  } catch {
    return false;
  }
}

function saveLibraryContexts(show: boolean): void {
  try {
    localStorage.setItem(LIBRARY_CONTEXTS_KEY, show ? '1' : '0');
  } catch {
    // not essential
  }
}

function readChoice(): StoreChoice | null {
  try {
    const saved = JSON.parse(localStorage.getItem(CHOICE_KEY) ?? 'null') as Partial<StoreChoice> | null;
    if (typeof saved?.id === 'string' && typeof saved.library === 'string' && typeof saved.label === 'string') {
      return { sessionId: String(saved.sessionId), id: saved.id, library: saved.library, label: saved.label };
    }
  } catch {
    // storage blocked or not JSON: start from the first store
  }
  return null;
}

function saveChoice(choice: StoreChoice): void {
  try {
    localStorage.setItem(CHOICE_KEY, JSON.stringify(choice));
  } catch {
    // not essential
  }
}
