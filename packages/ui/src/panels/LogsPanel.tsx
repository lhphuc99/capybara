import type { LogLevel, LogSource, SerializedValue } from '@capybara/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useMemo, useRef, useState } from 'react';
import { JsonTree } from '../components/JsonTree';
import { useFollow } from '../follow';
import { formatLogMessage, formatTime, isSpecial, makeMatcher } from '../format';
import { clearSession, type LogEntry, type SessionState } from '../store';

const LEVELS: Array<{ level: LogLevel; label: string }> = [
  { level: 'error', label: 'Errors' },
  { level: 'warn', label: 'Warnings' },
  { level: 'info', label: 'Info' },
  { level: 'log', label: 'Logs' },
  { level: 'debug', label: 'Debug' },
];

const SOURCE_LABELS: Record<LogSource, string | null> = {
  console: null,
  api: 'api',
  uncaught: 'uncaught',
  unhandledrejection: 'unhandled rejection',
};

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

function expandable(value: SerializedValue): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isSpecial(value)) {
    if (value.$t === 'object') return Object.keys(value.props).length > 0 || !!value.more;
    return value.$t === 'error' || value.$t === 'array' || value.$t === 'map' || value.$t === 'set';
  }
  return Object.keys(value).length > 0;
}

export function LogsPanel({ session }: { session: SessionState }) {
  const [query, setQuery] = useState('');
  const [hidden, setHidden] = useState<ReadonlySet<LogLevel>>(() => new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const listRef = useRef<HTMLDivElement>(null);
  const { logs } = session;

  const matcher = useMemo(() => makeMatcher(query), [query]);
  const counts = useMemo(() => {
    const result: Record<LogLevel, number> = { error: 0, warn: 0, info: 0, log: 0, debug: 0 };
    for (const entry of logs) result[entry.level]++;
    return result;
  }, [logs]);
  const visible = useMemo(
    () => logs.filter((entry) => !hidden.has(entry.level) && (!matcher || matcher.test(searchText(entry)))),
    [logs, hidden, matcher],
  );

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

  return (
    <section className="panel">
      <div className="toolbar">
        <input
          className={`search${matcher?.invalid ? ' invalid' : ''}`}
          placeholder="Filter logs (text or /regex/)"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          spellCheck={false}
        />
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
        <button type="button" className="btn" onClick={() => clearSession(session.meta.info.id)} disabled={logs.length === 0}>
          Clear
        </button>
      </div>

      <div className="list-wrap">
        {logs.length === 0 ? (
          <div className="empty">
            <strong>No logs yet</strong>
            <p>Anything the app writes with console.log, console.warn or console.error shows up here.</p>
          </div>
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
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
                  >
                    <LogRow entry={entry} expanded={expanded.has(entry.seq)} onToggle={toggleRow} />
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

const LogRow = memo(function LogRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: LogEntry;
  expanded: boolean;
  onToggle: (seq: number) => void;
}) {
  const canExpand = entry.args.some(expandable);
  const source = SOURCE_LABELS[entry.source];
  return (
    <>
      <div className={`log-line${canExpand ? ' clickable' : ''}`} onClick={canExpand ? () => onToggle(entry.seq) : undefined}>
        <span className="log-time">{formatTime(entry.ts)}</span>
        {canExpand ? <span className={`caret${expanded ? ' open' : ''}`} /> : <span className="caret-space" />}
        <span className="log-message">{formatLogMessage(entry.args)}</span>
        {source && <span className="log-source">{source}</span>}
      </div>
      {expanded && (
        <div className="log-details">
          {entry.args.filter(expandable).map((arg, index) => (
            <JsonTree key={index} value={arg} expandDepth={1} />
          ))}
        </div>
      )}
    </>
  );
});
