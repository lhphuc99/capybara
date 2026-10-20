import type { StateEntrySummary } from '@capybara-devtools/protocol';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { EntryTable } from '../components/EntryTable';
import { ColumnHandle, ResizeHandle, useColumnWidth, usePaneWidth } from '../components/ResizeHandle';
import { SearchInput } from '../components/SearchInput';
import { StateTimeline } from '../components/StateTimeline';
import { stateCommand } from '../connection';
import { makeMatcher } from '../format';
import { readJsonPref, readPref, writePref } from '../prefs';
import {
  entryFilters,
  entryMatches,
  groupStores,
  isEntryStore,
  libraryContextCount,
  pickStore,
  recordText,
  storeCount,
  type EntryFilter,
  type StoreChoice,
  type StoreGroup,
  type StoreView,
} from '../state';
import { clearStateTimeline, loadStateEntries, mergeStateStores, type SessionState } from '../store';
import { EntryDetail, type EntryTab } from './state/EntryDetail';
import { NoStores } from './state/NoStores';
import { RecordDetail, type RecordTab } from './state/RecordDetail';

const CHOICE_KEY = 'capybara:state:store';
const LIBRARY_CONTEXTS_KEY = 'capybara:state:library-contexts';

const FILTER_LABELS: Record<EntryFilter, string> = {
  all: 'All',
  fetching: 'Fetching',
  stale: 'Stale',
  error: 'Error',
  inactive: 'Inactive',
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
  // The panel still shows what it has, which may be missing stores or entries the app was asked for.
  const [storesError, setStoresError] = useState<string | null>(null);
  const [entriesError, setEntriesError] = useState<{ store: string; message: string } | null>(null);
  const [libraryContexts, setLibraryContexts] = useState(readLibraryContexts);
  const layoutRef = useRef<HTMLDivElement>(null);
  const pane = usePaneWidth('capybara:pane:state', 44);
  const nav = useColumnWidth('capybara:column:state-stores');
  const navRef = useRef<HTMLDivElement>(null);

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
        if (cancelled) return;
        mergeStateStores(sessionId, stores);
        setStoresError(null);
      },
      (reason: Error) => {
        if (!cancelled) setStoresError(reason.message);
      },
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
        setEntriesError(null);
      },
      (reason: Error) => {
        if (!cancelled) setEntriesError({ store: storeId, message: reason.message });
      },
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

  const storesCallout = storesError && <p className="callout error inline">Could not ask the app for its stores: {storesError}</p>;
  if (!store) {
    return (
      <>
        {storesCallout}
        <NoStores session={session} libraryContexts={libraryCount} onShowLibraryContexts={() => toggleLibraryContexts(true)} />
      </>
    );
  }

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
    <SearchInput
      value={query}
      onChange={setQuery}
      placeholder={
        entryStore
          ? store.info.library === 'tanstack-query'
            ? 'Filter query keys'
            : 'Filter keys'
          : store.info.actions
            ? 'Filter actions and paths'
            : 'Filter paths'
      }
      invalid={matcher?.invalid}
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
      {storesCallout}
      {entryStore && entriesError?.store === store.info.id && (
        <p className="callout error inline">
          Could not read the {store.info.library === 'tanstack-query' ? 'queries' : 'keys'} from the app: {entriesError.message}
        </p>
      )}

      <div
        ref={layoutRef}
        className="state-layout"
        style={{ '--pane-width': `${pane.width}%`, ...(nav.width && { '--nav-width': `${nav.width}px` }) } as CSSProperties}
      >
        <div ref={navRef} className="nav-column">
          <StoreNav
            groups={groups}
            selected={store}
            onSelect={selectStore}
            libraryContexts={libraryCount > 0 ? { shown: libraryContexts, count: libraryCount, onToggle: toggleLibraryContexts } : undefined}
          />
          <ColumnHandle
            target={navRef}
            edge="end"
            min={140}
            // The changes keep 350px and the details pane 320px.
            max={() => Math.min(400, (layoutRef.current?.clientWidth ?? 0) - 670)}
            onChange={nav.setWidth}
            onCommit={nav.save}
            onReset={nav.reset}
            label="Resize the list of stores"
          />
        </div>
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

function entriesNote(store: StoreView, entries: StateEntrySummary[], visible: number, total: number | undefined): string {
  if (visible !== entries.length) return `${visible} of ${entries.length}`;
  const mutations = entries.filter((entry) => entry.kind === 'mutation').length;
  const listed =
    store.info.library === 'tanstack-query'
      ? `${count(entries.length - mutations, 'query', 'queries')} · ${count(mutations, 'mutation')}`
      : count(entries.length, 'key');
  return total !== undefined && total > entries.length ? `${listed} (${total} in the app)` : listed;
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function readLibraryContexts(): boolean {
  return readPref(LIBRARY_CONTEXTS_KEY) === '1';
}

function saveLibraryContexts(show: boolean): void {
  writePref(LIBRARY_CONTEXTS_KEY, show ? '1' : '0');
}

/** None saved, or not one: start from the first store. */
function readChoice(): StoreChoice | null {
  const saved = readJsonPref(CHOICE_KEY) as Partial<StoreChoice> | null | undefined;
  if (typeof saved?.id === 'string' && typeof saved.library === 'string' && typeof saved.label === 'string') {
    return { sessionId: String(saved.sessionId), id: saved.id, library: saved.library, label: saved.label };
  }
  return null;
}

function saveChoice(choice: StoreChoice): void {
  writePref(CHOICE_KEY, JSON.stringify(choice));
}
