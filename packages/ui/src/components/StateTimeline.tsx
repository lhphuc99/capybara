import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useMemo, useRef, type KeyboardEvent } from 'react';
import { useFollow } from '../follow';
import { formatTime } from '../format';
import { useListKeys } from '../listKeys';
import { recordLabel, type StateRecord } from '../state';

const ROW_HEIGHT = 28;
const MARKER_HEIGHT = 26;

type Row = { kind: 'record' | 'skipped' | 'missed'; record: StateRecord; index: number };

interface Props {
  /** The records to list, already filtered. */
  records: StateRecord[];
  /** Records before filtering, to tell an empty store from a filter that matches nothing. */
  total: number;
  /** False for stores whose changes carry no action names. */
  actions: boolean;
  selectedSeq?: number;
  onSelect: (seq: number) => void;
}

/** A store's changes, oldest first, staying on the newest until the user scrolls up. */
export function StateTimeline({ records, total, actions, selectedSeq, onSelect }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  // The rows include markers between the records; `rowOf` is the row of each record.
  const { rows, rowOf } = useMemo(() => {
    const list: Row[] = [];
    const indexes: number[] = [];
    records.forEach((record, index) => {
      if (record.missed > 0) list.push({ kind: 'missed', record, index });
      if (record.skipped > 0) list.push({ kind: 'skipped', record, index });
      indexes.push(list.length);
      list.push({ kind: 'record', record, index });
    });
    return { rows: list, rowOf: indexes };
  }, [records]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => bodyRef.current,
    estimateSize: (index) => (rows[index]!.kind === 'record' ? ROW_HEIGHT : MARKER_HEIGHT),
    overscan: 15,
    getItemKey: (index) => `${rows[index]!.record.seq}:${rows[index]!.kind}`,
    useFlushSync: false,
  });

  const { onScroll, onWheel } = useFollow(bodyRef, virtualizer.getTotalSize(), ROW_HEIGHT);
  const noun = actions ? 'action' : 'change';
  const seqs = useMemo(() => records.map((record) => record.seq), [records]);
  const onRowKey = useListKeys({
    listRef: bodyRef,
    keys: seqs,
    scrollToIndex: (index) => virtualizer.scrollToIndex(rowOf[index]!),
    onMove: onSelect,
  });
  const tabbable = selectedSeq !== undefined && seqs.includes(selectedSeq) ? selectedSeq : seqs.at(-1);

  return (
    <div className="entries state-timeline">
      <div className="entry-head">
        <span>Time</span>
        <span>{actions ? 'Action' : 'Paths'}</span>
        <span className="num">Changes</span>
      </div>
      {records.length === 0 ? (
        <div className="empty small">{total === 0 ? `No ${noun}s recorded yet.` : `No ${noun}s match the filter.`}</div>
      ) : (
        <div className="entry-body" ref={bodyRef} role="listbox" aria-label={`${noun[0]!.toUpperCase()}${noun.slice(1)}s`} onScroll={onScroll} onWheel={onWheel}>
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const { kind, record, index } = rows[item.index]!;
              if (kind === 'record') {
                return (
                  <RecordRow
                    key={item.key}
                    record={record}
                    index={index}
                    top={item.start}
                    actions={actions}
                    selected={record.seq === selectedSeq}
                    tabbable={record.seq === tabbable}
                    onSelect={onSelect}
                    onKey={onRowKey}
                  />
                );
              }
              const position = {
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: MARKER_HEIGHT,
                transform: `translateY(${item.start}px)`,
              } as const;
              return kind === 'skipped' ? (
                <div
                  key={item.key}
                  className="state-marker"
                  style={position}
                  title="Too many at once, or the app was offline. The next row's changes include theirs."
                >
                  {`${plural(record.skipped, noun)} skipped · folded into the next one`}
                </div>
              ) : (
                <div key={item.key} className="state-marker" style={position} title="Lost on the way, e.g. while the server restarted.">
                  {`${plural(record.missed, 'change')} missed`}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

const RecordRow = memo(function RecordRow({
  record,
  index,
  top,
  actions,
  selected,
  tabbable,
  onSelect,
  onKey,
}: {
  record: StateRecord;
  index: number;
  top: number;
  actions: boolean;
  selected: boolean;
  tabbable: boolean;
  onSelect: (seq: number) => void;
  onKey: (event: KeyboardEvent, index: number) => void;
}) {
  const label = recordLabel(record);
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={tabbable ? 0 : -1}
      data-row={record.seq}
      className={`entry-row${selected ? ' selected' : ''}`}
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: ROW_HEIGHT, transform: `translateY(${top}px)` }}
      onClick={() => onSelect(record.seq)}
      onKeyDown={(event) => onKey(event, index)}
    >
      <span className="state-faint">{formatTime(record.ts)}</span>
      <span className={`state-action${label.system ? ' system' : ''}`} title={label.text}>
        {label.text}
        {/* Only where changes come from dispatches does one from elsewhere stand out. */}
        {actions && record.cause === 'external' && (
          <span className="state-tag" title="Changed outside a dispatch">
            {/^@@redux\/REPLACE/.test(label.text) ? 'hot reload' : 'external'}
          </span>
        )}
      </span>
      <span className="num state-faint">{record.cause === 'init' ? 'initial' : record.opCount === 0 ? '—' : record.opCount}</span>
    </div>
  );
});
