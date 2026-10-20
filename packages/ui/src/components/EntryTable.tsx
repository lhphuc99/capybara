import type { StateEntrySummary } from '@capybara-devtools/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useMemo, useRef, type KeyboardEvent } from 'react';
import { formatTime } from '../format';
import { useListKeys } from '../listKeys';
import { entryPills, type Pill } from '../state';

const ROW_HEIGHT = 28;
const SECTION_HEIGHT = 26;

type Row = { kind: 'entry'; entry: StateEntrySummary; index: number } | { kind: 'section'; title: string };

interface Props {
  /** The entries to list, already filtered, in cache order. */
  entries: StateEntrySummary[];
  /** Entries before filtering, to tell an empty cache from a filter that matches nothing. */
  total: number;
  keyTitle: string;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}

/** A cache's queries (or keys), then its mutations. */
export function EntryTable({ entries, total, keyTitle, selectedKey, onSelect }: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);
  // Entries in the order they are listed, and the row of each, which sections sit between.
  const { rows, order, rowOf } = useMemo(() => {
    const queries = entries.filter((entry) => entry.kind !== 'mutation');
    const mutations = entries.filter((entry) => entry.kind === 'mutation');
    const listed = [...queries, ...mutations];
    const list: Row[] = queries.map((entry, index) => ({ kind: 'entry', entry, index }));
    if (mutations.length > 0) {
      list.push({ kind: 'section', title: 'Mutations' }, ...mutations.map((entry, i): Row => ({ kind: 'entry', entry, index: queries.length + i })));
    }
    const rowIndexes = listed.map((_, index) => (index < queries.length ? index : index + 1));
    return { rows: list, order: listed.map((entry) => entry.key), rowOf: rowIndexes };
  }, [entries]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => bodyRef.current,
    estimateSize: (index) => (rows[index]!.kind === 'entry' ? ROW_HEIGHT : SECTION_HEIGHT),
    overscan: 15,
    getItemKey: (index) => {
      const row = rows[index]!;
      return row.kind === 'entry' ? row.entry.key : `section:${row.title}`;
    },
    useFlushSync: false,
  });

  const onRowKey = useListKeys({
    listRef: bodyRef,
    keys: order,
    scrollToIndex: (index) => virtualizer.scrollToIndex(rowOf[index]!),
    onMove: onSelect,
  });
  const tabbable = selectedKey !== null && order.includes(selectedKey) ? selectedKey : order[0];

  return (
    <div className="entries state-cache">
      <div className="entry-head">
        <span>{keyTitle}</span>
        <span>Status</span>
        <span className="num">Obs</span>
        <span className="num">Updated</span>
      </div>
      {entries.length === 0 ? (
        <div className="empty small">{total === 0 ? 'The cache is empty.' : 'No entries match the filter.'}</div>
      ) : (
        <div className="entry-body" ref={bodyRef} role="listbox" aria-label={keyTitle}>
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]!;
              if (row.kind === 'entry') {
                return (
                  <EntryRow
                    key={item.key}
                    entry={row.entry}
                    index={row.index}
                    top={item.start}
                    selected={row.entry.key === selectedKey}
                    tabbable={row.entry.key === tabbable}
                    onSelect={onSelect}
                    onKey={onRowKey}
                  />
                );
              }
              return (
                <div
                  key={item.key}
                  className="state-section"
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: SECTION_HEIGHT, transform: `translateY(${item.start}px)` }}
                >
                  {row.title}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function Pills({ pills }: { pills: Pill[] }) {
  return (
    <>
      {pills.map((pill) => (
        <span key={pill.text} className={`state-pill ${pill.tone}`}>
          {pill.text}
        </span>
      ))}
    </>
  );
}

const EntryRow = memo(function EntryRow({
  entry,
  index,
  top,
  selected,
  tabbable,
  onSelect,
  onKey,
}: {
  entry: StateEntrySummary;
  index: number;
  top: number;
  selected: boolean;
  tabbable: boolean;
  onSelect: (key: string) => void;
  onKey: (event: KeyboardEvent, index: number) => void;
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={tabbable ? 0 : -1}
      data-row={entry.key}
      className={`entry-row${entry.status === 'error' ? ' tone-error' : ''}${selected ? ' selected' : ''}`}
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: ROW_HEIGHT, transform: `translateY(${top}px)` }}
      onClick={() => onSelect(entry.key)}
      onKeyDown={(event) => onKey(event, index)}
    >
      <span className="entry-key" title={entry.label}>
        {entry.label}
      </span>
      <span>
        <Pills pills={entryPills(entry)} />
      </span>
      <span className="num">{entry.observers ?? ''}</span>
      <span className="num state-faint">{entry.updatedAt ? formatTime(entry.updatedAt).slice(0, 8) : '—'}</span>
    </div>
  );
});
