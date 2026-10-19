import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useMemo, useRef } from 'react';
import { useFollow } from '../follow';
import { formatTime } from '../format';
import { recordLabel, type StateRecord } from '../state';

const ROW_HEIGHT = 28;
const MARKER_HEIGHT = 26;

type Row = { kind: 'record' | 'skipped' | 'missed'; record: StateRecord };

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
  const rows = useMemo(() => {
    const list: Row[] = [];
    for (const record of records) {
      if (record.missed > 0) list.push({ kind: 'missed', record });
      if (record.skipped > 0) list.push({ kind: 'skipped', record });
      list.push({ kind: 'record', record });
    }
    return list;
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
        <div className="entry-body" ref={bodyRef} onScroll={onScroll} onWheel={onWheel}>
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const { kind, record } = rows[item.index]!;
              if (kind === 'record') {
                return (
                  <RecordRow
                    key={item.key}
                    record={record}
                    top={item.start}
                    actions={actions}
                    selected={record.seq === selectedSeq}
                    onSelect={onSelect}
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
  top,
  actions,
  selected,
  onSelect,
}: {
  record: StateRecord;
  top: number;
  actions: boolean;
  selected: boolean;
  onSelect: (seq: number) => void;
}) {
  const label = recordLabel(record);
  return (
    <div
      className={`entry-row${selected ? ' selected' : ''}`}
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: ROW_HEIGHT, transform: `translateY(${top}px)` }}
      onClick={() => onSelect(record.seq)}
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
