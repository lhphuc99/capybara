import type { SerializedValue, StatePath } from '@capybara-devtools/protocol';
import { useCallback, useMemo } from 'react';
import { CopyButton } from '../../components/CopyButton';
import { DiffView } from '../../components/DiffView';
import { JsonTree } from '../../components/JsonTree';
import { stateCommand } from '../../connection';
import { formatTime, isSpecial, valueText } from '../../format';
import { changedPaths, diffText, recordLabel, type StateRecord, type StoreView } from '../../state';
import { ROOT, useAppValue, type AppValue, type StateRead } from './appValue';

export type RecordTab = 'diff' | 'action' | 'state';

/** Up to this many providers of a context under one name, the SDK keeps each one's value in the state. */
const KEYED_PROVIDERS = 20;

const RECORD_TABS: Record<RecordTab, string> = { diff: 'Diff', action: 'Action', state: 'State' };

export function RecordDetail({
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
