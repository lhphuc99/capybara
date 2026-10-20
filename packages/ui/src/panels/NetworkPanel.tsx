import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { EmptyMessage } from '../components/EmptyMessage';
import { ColumnHandle, ResizeHandle, useColumnWidth, usePaneWidth } from '../components/ResizeHandle';
import { SearchInput } from '../components/SearchInput';
import { useFollow } from '../follow';
import { formatBytes, formatDuration, isFetchOrXhr, makeMatcher, responseSize, splitUrl, statusTone } from '../format';
import { clearSession, type NetworkEntry, type SessionState } from '../store';
import { RequestDetail } from './network/RequestDetail';
import { SocketDetail, type SocketEntry } from './network/SocketDetail';

type Filter = 'all' | 'fetch-xhr' | 'ws' | 'failed';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'fetch-xhr', label: 'Fetch/XHR' },
  { id: 'ws', label: 'WS' },
  { id: 'failed', label: 'Failed' },
];

const ROW_HEIGHT = 26;

// Entries are immutable, so the headers and bodies a search reads are joined once per entry.
const contentTexts = new WeakMap<NetworkEntry, string>();
function contentText(entry: NetworkEntry): string {
  let text = contentTexts.get(entry);
  if (text === undefined) {
    const headers = (record: Record<string, string> | undefined) =>
      Object.entries(record ?? {}).map(([name, value]) => `${name}: ${value}`);
    text = [
      ...headers(entry.requestHeaders),
      ...headers(entry.responseHeaders),
      entry.requestBody?.text,
      entry.responseBody?.text,
      entry.error,
      ...(entry.socket?.messages.map((message) => message.data.text) ?? []),
    ]
      .filter(Boolean)
      .join('\n');
    contentTexts.set(entry, text);
  }
  return text;
}

export function NetworkPanel({ session }: { session: SessionState }) {
  const [query, setQuery] = useState('');
  const [inContent, setInContent] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  // While paused, requests after this one wait out of the list, so it holds still.
  const [paused, setPaused] = useState<{ sessionId: string; seq: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const pane = usePaneWidth('capybara:pane:network', 46);
  const host = useColumnWidth('capybara:column:network-host');
  const tableRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLSpanElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { network } = session;
  const sessionId = session.meta.info.id;
  const pausedAt = paused?.sessionId === sessionId ? paused.seq : undefined;
  const listed = useMemo(() => (pausedAt === undefined ? network : network.filter((entry) => entry.seq <= pausedAt)), [network, pausedAt]);

  const matcher = useMemo(() => makeMatcher(query), [query]);
  const visible = useMemo(
    () =>
      listed.filter((entry) => {
        if (filter === 'fetch-xhr' && !isFetchOrXhr(entry.initiator)) return false;
        if (filter === 'ws' && entry.initiator !== 'websocket') return false;
        if (filter === 'failed' && statusTone(entry) !== 'error') return false;
        if (!matcher) return true;
        return matcher.test(`${entry.method} ${entry.url} ${entry.status ?? ''}`) || (inContent && matcher.test(contentText(entry)));
      }),
    [listed, filter, matcher, inContent],
  );
  const selected = selectedId ? network.find((entry) => entry.id === selectedId) : undefined;

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => bodyRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 15,
    getItemKey: (index) => visible[index]!.id,
    useFlushSync: false,
  });

  const { onScroll, onWheel } = useFollow(bodyRef, virtualizer.getTotalSize(), ROW_HEIGHT);

  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedId(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected]);

  const resize = (
    <ResizeHandle
      container={layoutRef}
      width={pane.width}
      min={25}
      max={75}
      onChange={pane.setWidth}
      onCommit={pane.save}
      onReset={pane.reset}
      label="Resize the details pane"
    />
  );

  return (
    <section className="panel">
      <div className="toolbar">
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={inContent ? 'Filter by URL, headers or body' : 'Filter by URL, method or status'}
          invalid={matcher?.invalid}
        />
        <button
          type="button"
          className="chip"
          aria-pressed={inContent}
          title="Also match request and response headers, bodies and WebSocket messages"
          onClick={() => setInContent(!inContent)}
        >
          Headers &amp; bodies
        </button>
        <div className="chips">
          {FILTERS.map(({ id, label }) => (
            <button key={id} type="button" className="chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="note">
          {visible.length === listed.length ? `${listed.length} requests` : `${visible.length} of ${listed.length}`}
          {pausedAt !== undefined && ` · paused, ${network.length - listed.length} new`}
        </span>
        <button
          type="button"
          className="btn"
          aria-pressed={pausedAt !== undefined}
          title={pausedAt === undefined ? 'Stop adding new requests to the list' : 'Add the requests that came in meanwhile'}
          onClick={() => setPaused(pausedAt === undefined ? { sessionId, seq: network.at(-1)?.seq ?? 0 } : null)}
        >
          {pausedAt === undefined ? 'Pause' : 'Resume'}
        </button>
        <button type="button" className="btn" onClick={() => clearSession(sessionId)} disabled={network.length === 0}>
          Clear
        </button>
      </div>

      <div
        ref={layoutRef}
        className={`network${selected ? ' with-detail' : ''}`}
        style={{ '--pane-width': `${pane.width}%` } as CSSProperties}
      >
        <div
          ref={tableRef}
          className="net-table"
          style={host.width ? ({ '--host-width': `${host.width}px` } as CSSProperties) : undefined}
        >
          <div className="net-head">
            <span>Status</span>
            <span>Method</span>
            <span>Path</span>
            <span ref={hostRef} className="resizable-column">
              Host
              <ColumnHandle
                target={hostRef}
                edge="start"
                inset={5}
                min={80}
                // The other columns, their gaps and a path of 160px stay.
                max={() => (tableRef.current?.clientWidth ?? 0) - 582}
                onChange={host.setWidth}
                onCommit={host.save}
                onReset={host.reset}
                label="Resize the path and host columns"
              />
            </span>
            <span>Type</span>
            <span className="num">Size</span>
            <span className="num">Time</span>
          </div>
          {network.length === 0 ? (
            <EmptyMessage title="No requests yet">
              <p>Requests made with fetch, XMLHttpRequest or axios, and WebSocket connections, show up here.</p>
            </EmptyMessage>
          ) : (
            <div className="net-body" ref={bodyRef} onScroll={onScroll} onWheel={onWheel}>
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const entry = visible[item.index]!;
                  return (
                    <NetworkRow
                      key={item.key}
                      entry={entry}
                      top={item.start}
                      selected={entry.id === selectedId}
                      onSelect={() => setSelectedId(entry.id === selectedId ? null : entry.id)}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </div>
        {selected?.socket ? (
          <SocketDetail entry={selected as SocketEntry} onClose={() => setSelectedId(null)} resize={resize} />
        ) : (
          selected && (
            <RequestDetail key={selected.id} entry={selected} session={session} onClose={() => setSelectedId(null)} resize={resize} />
          )
        )}
      </div>
    </section>
  );
}

function NetworkRow({
  entry,
  top,
  selected,
  onSelect,
}: {
  entry: NetworkEntry;
  top: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const { path, host } = splitUrl(entry.url);
  const tone = statusTone(entry);
  return (
    <div
      className={`net-row tone-${tone}${selected ? ' selected' : ''}`}
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: ROW_HEIGHT, transform: `translateY(${top}px)` }}
      onClick={onSelect}
      title={entry.url}
    >
      <span className="net-status">
        {entry.state === 'pending' ? (entry.streaming ? entry.status : 'pending') : entry.state === 'failed' ? failedLabel(entry) : entry.status}
      </span>
      <span>{entry.method}</span>
      <span className="net-path">{path || '/'}</span>
      <span className="muted">{host}</span>
      <span className="muted">{entry.initiator}</span>
      <span className="num muted">{formatBytes(responseSize(entry))}</span>
      <span className="num">{entry.streaming ? 'streaming' : entry.state === 'open' ? 'open' : formatDuration(entry.duration)}</span>
    </div>
  );
}

function failedLabel(entry: NetworkEntry): string {
  const { failure } = entry;
  if (failure?.aborted) return 'cancelled';
  if (failure?.timeout) return 'timeout';
  if (failure?.cause === 'offline') return 'offline';
  if (failure?.cause === 'csp' || failure?.cause === 'mixed-content') return 'blocked';
  return 'failed';
}
