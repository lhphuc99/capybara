import type { LogLevel } from '@capybara-devtools/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useMemo, useRef, useState, type CSSProperties } from 'react';
import { CopyButton } from '../components/CopyButton';
import { EmptyMessage } from '../components/EmptyMessage';
import { JsonTree } from '../components/JsonTree';
import { LogTable } from '../components/LogTable';
import { SearchInput } from '../components/SearchInput';
import { useFollow } from '../follow';
import { formatLogMessage, formatTime, isExpandable, LOG_SOURCE_LABELS, logEntryText, makeMatcher } from '../format';
import { clearSession, type LogEntry, type SessionState } from '../store';

const LEVELS: Array<{ level: LogLevel; label: string }> = [
  { level: 'error', label: 'Errors' },
  { level: 'warn', label: 'Warnings' },
  { level: 'info', label: 'Info' },
  { level: 'log', label: 'Logs' },
  { level: 'debug', label: 'Debug' },
];

const isGroup = (entry: LogEntry) => entry.method === 'group' || entry.method === 'groupCollapsed';
/** `toggled` holds the groups opened or closed by hand; console.groupCollapsed() starts closed. */
const groupOpen = (entry: LogEntry, toggled: ReadonlySet<number>) => (entry.method === 'group') !== toggled.has(entry.seq);

// Entries are immutable, so the text used for filtering is built once per entry.
const searchTexts = new WeakMap<LogEntry, string>();
function searchText(entry: LogEntry): string {
  let text = searchTexts.get(entry);
  if (text === undefined) {
    text = `${formatLogMessage(entry.args)}\n${JSON.stringify(entry.args)}`;
    searchTexts.set(entry, text);
  }
  return text;
}

export function LogsPanel({ session }: { session: SessionState }) {
  const [query, setQuery] = useState('');
  const [hidden, setHidden] = useState<ReadonlySet<LogLevel>>(() => new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [toggledGroups, setToggledGroups] = useState<ReadonlySet<number>>(() => new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const { logs } = session;

  const matcher = useMemo(() => makeMatcher(query), [query]);
  const counts = useMemo(() => {
    const result: Record<LogLevel, number> = { error: 0, warn: 0, info: 0, log: 0, debug: 0 };
    for (const entry of logs) result[entry.level]++;
    return result;
  }, [logs]);
  const visible = useMemo(() => {
    const shown: LogEntry[] = [];
    // The entries after a closed group's line and deeper than it are in the group. A search shows every match.
    let closedAt: number | undefined;
    for (const entry of logs) {
      const depth = entry.depth ?? 0;
      if (closedAt !== undefined && !matcher) {
        if (depth > closedAt) continue;
        closedAt = undefined;
      }
      if (isGroup(entry) && !groupOpen(entry, toggledGroups)) closedAt = depth;
      if (!hidden.has(entry.level) && (!matcher || matcher.test(searchText(entry)))) shown.push(entry);
    }
    return shown;
  }, [logs, hidden, matcher, toggledGroups]);

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 25,
    overscan: 12,
    getItemKey: (index) => visible[index]!.seq,
    // flushSync during measurement warns under React 19.
    useFlushSync: false,
  });

  const { follow, setFollow, onScroll, onWheel } = useFollow(listRef, virtualizer.getTotalSize(), 32);

  const toggleLevel = (level: LogLevel) => {
    const next = new Set(hidden);
    if (next.has(level)) next.delete(level);
    else next.add(level);
    setHidden(next);
  };

  const toggleRow = (seq: number) => {
    const next = new Set(expanded);
    if (next.has(seq)) next.delete(seq);
    else next.add(seq);
    setExpanded(next);
  };

  const toggleGroup = (seq: number) => {
    const next = new Set(toggledGroups);
    if (next.has(seq)) next.delete(seq);
    else next.add(seq);
    setToggledGroups(next);
  };

  return (
    <section className="panel">
      <div className="toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder="Filter logs (text or /regex/)" invalid={matcher?.invalid} />
        <div className="chips">
          {LEVELS.map(({ level, label }) => (
            <button
              key={level}
              type="button"
              className={`chip chip-${level}`}
              aria-pressed={!hidden.has(level)}
              onClick={() => toggleLevel(level)}
            >
              {label} <span className="n">{counts[level]}</span>
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="note">
          {visible.length === logs.length ? `${logs.length} entries` : `${visible.length} of ${logs.length}`}
        </span>
        <CopyButton
          className="btn"
          label={visible.length === logs.length ? 'Copy all logs as text' : 'Copy the logs that match the filters as text'}
          text={() => visible.map(logEntryText).join('\n')}
          toast={`Copied ${visible.length} log ${visible.length === 1 ? 'entry' : 'entries'} to the clipboard`}
          disabled={visible.length === 0}
        >
          {visible.length === logs.length ? 'Copy all' : `Copy ${visible.length}`}
        </CopyButton>
        <button type="button" className="btn" onClick={() => clearSession(session.meta.info.id)} disabled={logs.length === 0}>
          Clear
        </button>
      </div>

      <div className="list-wrap">
        {logs.length === 0 ? (
          <EmptyMessage title="No logs yet">
            <p>Anything the app writes with console.log, console.warn or console.error shows up here.</p>
          </EmptyMessage>
        ) : (
          <div className="log-list" ref={listRef} onScroll={onScroll} onWheel={onWheel}>
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((item) => {
                const entry = visible[item.index]!;
                return (
                  <div
                    key={item.key}
                    data-index={item.index}
                    ref={virtualizer.measureElement}
                    className={`log-row level-${entry.level}`}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${item.start}px)`,
                      ...(entry.depth && ({ '--depth': entry.depth } as CSSProperties)),
                    }}
                  >
                    <LogRow
                      entry={entry}
                      expanded={isGroup(entry) ? groupOpen(entry, toggledGroups) : expanded.has(entry.seq)}
                      onToggle={isGroup(entry) ? toggleGroup : toggleRow}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {!follow && visible.length > 0 && (
          <button type="button" className="btn primary jump" onClick={() => setFollow(true)}>
            ↓ Jump to latest
          </button>
        )}
      </div>
    </section>
  );
}

/** `expanded` opens a group's entries for a group, and the objects of any other entry. */
const LogRow = memo(function LogRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: LogEntry;
  expanded: boolean;
  onToggle: (seq: number) => void;
}) {
  const group = isGroup(entry);
  // A table shows its data already.
  const canExpand = group || (entry.method !== 'table' && entry.args.some(isExpandable));
  const source = LOG_SOURCE_LABELS[entry.source];
  return (
    <>
      <div
        className={`log-line${canExpand ? ' clickable' : ''}${group ? ' log-group' : ''}`}
        onClick={canExpand ? () => onToggle(entry.seq) : undefined}
      >
        <span className="log-time">{formatTime(entry.ts)}</span>
        {canExpand ? <span className={`caret${expanded ? ' open' : ''}`} /> : <span className="caret-space" />}
        <span className="log-message">{formatLogMessage(entry.args)}</span>
        {source && <span className="log-source">{source}</span>}
        <CopyButton label="Copy this log entry" text={() => logEntryText(entry)} />
      </div>
      {entry.method === 'table' && (
        <div className="log-details">
          <LogTable data={entry.args[0]} columns={entry.args[1]} />
        </div>
      )}
      {expanded && !group && (
        <div className="log-details">
          {entry.args.filter(isExpandable).map((arg, index) => (
            <JsonTree key={index} value={arg} expandDepth={1} />
          ))}
        </div>
      )}
    </>
  );
});
