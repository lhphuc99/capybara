import type { StateEntryOp, StateEntrySummary, StatePath } from '@capybara-devtools/protocol';
import { Fragment, useCallback, useState } from 'react';
import { Pills } from '../../components/EntryTable';
import { JsonTree } from '../../components/JsonTree';
import { stateCommand } from '../../connection';
import { formatTime } from '../../format';
import { entryFreshness, entryPills, type StoreView } from '../../state';
import { showToast } from '../../toast';
import { ROOT, useAppValue, type AppValue, type EntryRead } from './appValue';

export type EntryTab = 'data' | 'query';

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

export function EntryDetail({
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
