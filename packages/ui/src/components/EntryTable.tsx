import type { StateEntrySummary } from '@capybara-devtools/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useMemo, useRef } from 'react';
import { formatTime } from '../format';
import { entryPills, type Pill } from '../state';

const ROW_HEIGHT = 28;
const SECTION_HEIGHT = 26;

type Row = { kind: 'entry'; entry: StateEntrySummary } | { kind: 'section'; title: string };

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
  const rows = useMemo(() => {
    const list: Row[] = [];
    const mutations: Row[] = [];
    for (const entry of entries) (entry.kind === 'mutation' ? mutations : list).push({ kind: 'entry', entry });
    if (mutations.length > 0) list.push({ kind: 'section', title: 'Mutations' }, ...mutations);
    return list;
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
        <div className="entry-body" ref={bodyRef}>
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]!;
              if (row.kind === 'entry') {
                return (
                  <EntryRow
                    key={item.key}
                    entry={row.entry}
                    top={item.start}
                    selected={row.entry.key === selectedKey}
                    onSelect={onSelect}
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
  top,
  selected,
  onSelect,
}: {
  entry: StateEntrySummary;
  top: number;
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  return (
    <div
      className={`entry-row${entry.status === 'error' ? ' tone-error' : ''}${selected ? ' selected' : ''}`}
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: ROW_HEIGHT, transform: `translateY(${top}px)` }}
      onClick={() => onSelect(entry.key)}
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
