import type { BodyPreview, NetworkDiagnosis } from '@capybara-devtools/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { CopyButton } from '../components/CopyButton';
import { EmptyMessage } from '../components/EmptyMessage';
import { JsonTree } from '../components/JsonTree';
import { ColumnHandle, ResizeHandle, useColumnWidth, usePaneWidth } from '../components/ResizeHandle';
import { SearchInput } from '../components/SearchInput';
import { diagnose } from '../connection';
import { useFollow } from '../follow';
import {
  decodeSocketIo,
  formatBytes,
  formatDuration,
  formatTime,
  isFetchOrXhr,
  makeMatcher,
  parseJson,
  responseSize,
  splitUrl,
  statusTone,
  toCurl,
} from '../format';
import { clearSession, type NetworkEntry, type SessionState, type SocketInfo, type SocketMessage } from '../store';

type Filter = 'all' | 'fetch-xhr' | 'ws' | 'failed';
type DetailTab = 'headers' | 'request' | 'response';
type SocketEntry = NetworkEntry & { socket: SocketInfo };

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'fetch-xhr', label: 'Fetch/XHR' },
  { id: 'ws', label: 'WS' },
  { id: 'failed', label: 'Failed' },
];

const ROW_HEIGHT = 26;
const MESSAGE_ROW_HEIGHT = 24;

export function NetworkPanel({ session }: { session: SessionState }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const pane = usePaneWidth('capybara:pane:network', 46);
  const host = useColumnWidth('capybara:column:network-host');
  const tableRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLSpanElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { network } = session;

  const matcher = useMemo(() => makeMatcher(query), [query]);
  const visible = useMemo(
    () =>
      network.filter((entry) => {
        if (filter === 'fetch-xhr' && !isFetchOrXhr(entry.initiator)) return false;
        if (filter === 'ws' && entry.initiator !== 'websocket') return false;
        if (filter === 'failed' && statusTone(entry) !== 'error') return false;
        return !matcher || matcher.test(`${entry.method} ${entry.url} ${entry.status ?? ''}`);
      }),
    [network, filter, matcher],
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
        <SearchInput value={query} onChange={setQuery} placeholder="Filter by URL, method or status" invalid={matcher?.invalid} />
        <div className="chips">
          {FILTERS.map(({ id, label }) => (
            <button key={id} type="button" className="chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="note">
          {visible.length === network.length ? `${network.length} requests` : `${visible.length} of ${network.length}`}
        </span>
        <button
          type="button"
          className="btn"
          onClick={() => clearSession(session.meta.info.id)}
          disabled={network.length === 0}
        >
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
        {entry.state === 'pending' ? 'pending' : entry.state === 'failed' ? failedLabel(entry) : entry.status}
      </span>
      <span>{entry.method}</span>
      <span className="net-path">{path || '/'}</span>
      <span className="muted">{host}</span>
      <span className="muted">{entry.initiator}</span>
      <span className="num muted">{formatBytes(responseSize(entry))}</span>
      <span className="num">{entry.state === 'open' ? 'open' : formatDuration(entry.duration)}</span>
    </div>
  );
}

function SocketDetail({ entry, onClose, resize }: { entry: SocketEntry; onClose: () => void; resize: ReactNode }) {
  const [tab, setTab] = useState<'messages' | 'general'>('messages');
  return (
    <aside className="detail">
      {resize}
      <div className="detail-head">
        <div className="subtabs" role="tablist">
          {(['messages', 'general'] as const).map((id) => (
            <button key={id} type="button" role="tab" className="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {id === 'messages' ? 'Messages' : 'General'}
            </button>
          ))}
        </div>
        <div className="pane-actions">
          <button type="button" className="btn small icon" onClick={onClose} aria-label="Close details">
            ✕
          </button>
        </div>
      </div>
      {tab === 'messages' ? (
        <SocketMessages entry={entry} />
      ) : (
        <div className="detail-body">
          <SocketGeneral entry={entry} />
        </div>
      )}
    </aside>
  );
}

function SocketMessages({ entry }: { entry: SocketEntry }) {
  const { socket } = entry;
  const [direction, setDirection] = useState<'all' | 'sent' | 'received'>('all');
  const [query, setQuery] = useState('');
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const socketIo = entry.url.includes('/socket.io/');
  const matcher = useMemo(() => makeMatcher(query), [query]);
  const visible = useMemo(
    () =>
      socket.messages.filter(
        (message) =>
          (direction === 'all' || message.direction === direction) &&
          (!matcher || matcher.test(message.data.text ?? message.data.summary ?? '')),
      ),
    [socket.messages, direction, matcher],
  );
  const selected = selectedSeq === null ? undefined : socket.messages.find((message) => message.seq === selectedSeq);

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => MESSAGE_ROW_HEIGHT,
    overscan: 20,
    getItemKey: (index) => visible[index]!.seq,
    useFlushSync: false,
  });

  const { onScroll, onWheel } = useFollow(listRef, virtualizer.getTotalSize(), MESSAGE_ROW_HEIGHT);

  return (
    <div className="ws-pane">
      <div className="ws-toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder="Filter messages" invalid={matcher?.invalid} />
        <div className="chips">
          {(['all', 'sent', 'received'] as const).map((id) => (
            <button key={id} type="button" className="chip" aria-pressed={direction === id} onClick={() => setDirection(id)}>
              {id === 'all' ? 'All' : id === 'sent' ? '↑ Sent' : '↓ Received'}
            </button>
          ))}
        </div>
      </div>
      <div className="ws-summary note">
        {socket.sent} sent · {socket.received} received · {formatBytes(socket.bytes)}
        {socket.dropped > 0 && ` · ${socket.dropped} oldest not kept`}
      </div>
      {entry.state === 'failed' && (
        <div className="callout error inline">
          <strong>Connection failed</strong>
          <p>{entry.error}</p>
        </div>
      )}
      {socket.existing && <p className="callout inline">Already open when Capybara attached, so earlier messages are missing.</p>}
      {visible.length === 0 ? (
        <div className="empty small">
          <strong>{socket.messages.length === 0 ? 'No messages yet' : 'No matching messages'}</strong>
        </div>
      ) : (
        <div className="ws-list" ref={listRef} onScroll={onScroll} onWheel={onWheel}>
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const message = visible[item.index]!;
              return (
                <MessageRow
                  key={item.key}
                  message={message}
                  top={item.start}
                  socketIo={socketIo}
                  selected={message.seq === selectedSeq}
                  onSelect={() => setSelectedSeq(message.seq === selectedSeq ? null : message.seq)}
                />
              );
            })}
          </div>
        </div>
      )}
      {selected && <MessageView key={selected.seq} message={selected} socketIo={socketIo} />}
    </div>
  );
}

function MessageRow({
  message,
  top,
  socketIo,
  selected,
  onSelect,
}: {
  message: SocketMessage;
  top: number;
  socketIo: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { data } = message;
  const decoded = socketIo && data.text !== undefined ? decodeSocketIo(data.text) : undefined;
  const preview =
    data.text === undefined
      ? `${data.summary ?? data.kind} message`
      : decoded
        ? `${decoded.label}${decoded.payload ? ` ${decoded.payload}` : ''}`
        : data.text;
  return (
    <div
      className={`ws-row ${message.direction}${selected ? ' selected' : ''}`}
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: MESSAGE_ROW_HEIGHT, transform: `translateY(${top}px)` }}
      onClick={onSelect}
    >
      <span className="ws-dir" aria-label={message.direction}>
        {message.direction === 'sent' ? '↑' : '↓'}
      </span>
      <span className="ws-preview">{preview.slice(0, 300)}</span>
      <span className="num muted">{formatBytes(data.size)}</span>
      <span className="num muted">{formatTime(message.ts)}</span>
    </div>
  );
}

function MessageView({ message, socketIo }: { message: SocketMessage; socketIo: boolean }) {
  const { data } = message;
  const decoded = socketIo && data.text !== undefined ? decodeSocketIo(data.text) : undefined;
  const body = decoded ? { ...data, text: decoded.payload ?? '', contentType: `socket.io ${decoded.label}` } : data;
  return (
    <div className="ws-message">
      <p className="note">
        {message.direction === 'sent' ? 'Sent' : 'Received'} at {formatTime(message.ts)}
      </p>
      <BodyView body={body} empty="Empty message" copyable />
    </div>
  );
}

function SocketGeneral({ entry }: { entry: SocketEntry }) {
  const { socket } = entry;
  const closed = `${socket.closeCode !== undefined ? ` with code ${socket.closeCode}` : ''}${socket.closeReason ? `: ${socket.closeReason}` : ''}`;
  const status =
    entry.state === 'pending'
      ? 'Connecting'
      : entry.state === 'open'
        ? 'Open (101 Switching Protocols)'
        : entry.state === 'done'
          ? `Closed${closed}`
          : `Failed: ${entry.error ?? ''}${socket.closeCode !== undefined ? ` (code ${socket.closeCode})` : ''}`;
  const rows: Array<[string, string]> = [
    ['URL', entry.url],
    ['Status', status],
    ['Requested subprotocols', socket.protocols?.join(', ') || 'None'],
    ['Subprotocol', socket.protocol || 'None'],
    ['Extensions', socket.extensions || 'None'],
    ['Started', formatTime(entry.ts)],
    ['Handshake', formatDuration(socket.handshake)],
    ['Duration', entry.state === 'open' || entry.state === 'pending' ? 'Still open' : formatDuration(entry.duration)],
    ['Messages', `${socket.sent} sent, ${socket.received} received, ${formatBytes(socket.bytes)}`],
  ];
  return (
    <>
      <KeyValues title="General" rows={rows} />
      {socket.existing && <p className="note">Already open when Capybara attached; its start time is when Capybara first saw it.</p>}
    </>
  );
}

function RequestDetail({
  entry,
  session,
  onClose,
  resize,
}: {
  entry: NetworkEntry;
  session: SessionState;
  onClose: () => void;
  resize: ReactNode;
}) {
  const [tab, setTab] = useState<DetailTab>('response');

  return (
    <aside className="detail">
      {resize}
      <div className="detail-head">
        <div className="subtabs" role="tablist">
          {(['headers', 'request', 'response'] as const).map((id) => (
            <button key={id} type="button" role="tab" className="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {id === 'headers' ? 'Headers' : id === 'request' ? 'Request' : 'Response'}
            </button>
          ))}
        </div>
        <div className="pane-actions">
          <CopyButton
            className="btn small"
            label="Copy as a cURL command"
            text={() => toCurl(entry).command}
            toast={() => toCurl(entry).note ?? 'Copied to clipboard'}
          >
            Copy cURL
          </CopyButton>
          <button type="button" className="btn small icon" onClick={onClose} aria-label="Close details">
            ✕
          </button>
        </div>
      </div>
      <div className="detail-body">
        {tab === 'headers' && <HeadersTab entry={entry} />}
        {tab === 'request' && <BodyView body={entry.requestBody} empty="No request body" />}
        {tab === 'response' &&
          (entry.state === 'failed' ? (
            <FailureView entry={entry} session={session} />
          ) : entry.state === 'pending' ? (
            <p className="note">Waiting for the response…</p>
          ) : (
            <BodyView body={entry.responseBody} empty="No response body" copyable />
          ))}
      </div>
    </aside>
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

type DiagnosisState =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'done'; result: NetworkDiagnosis }
  | { state: 'error'; message: string };

const VERDICTS: Record<NetworkDiagnosis['verdict'], string> = {
  cors: 'Blocked by CORS',
  unreachable: 'The server could not be reached',
  ok: 'CORS allows this request',
  unknown: 'Capybara could not check this request',
};

function FailureView({ entry, session }: { entry: NetworkEntry; session: SessionState }) {
  const [diagnosis, setDiagnosis] = useState<DiagnosisState>({ state: 'idle' });
  const { info } = session.meta;
  const { title, text } = explainFailure(entry, info.url);
  const cause = entry.failure?.cause;
  // Offline, CSP and mixed-content blocks are already certain, and only pages are subject to CORS.
  const checkable = Boolean(info.url) && !entry.failure?.aborted && cause !== 'offline' && cause !== 'csp' && cause !== 'mixed-content';
  const run = () => {
    setDiagnosis({ state: 'running' });
    diagnose(info.id, entry.id).then(
      (result) => setDiagnosis({ state: 'done', result }),
      (error: Error) => setDiagnosis({ state: 'error', message: error.message }),
    );
  };

  return (
    <>
      <div className="callout error">
        <strong>{title}</strong>
        {text && <p>{text}</p>}
        {entry.error && <p className="failure-message">{entry.error}</p>}
      </div>
      {checkable && diagnosis.state !== 'done' && (
        <div className="diagnose-bar">
          <button type="button" className="btn small primary" disabled={diagnosis.state === 'running'} onClick={run}>
            {diagnosis.state === 'running' ? 'Checking…' : 'Find out why'}
          </button>
          {diagnosis.state === 'error' ? (
            <span className="note diagnose-error">{diagnosis.message}</span>
          ) : (
            <span className="note">Capybara asks the server again from this computer and applies the browser's rules.</span>
          )}
        </div>
      )}
      {diagnosis.state === 'done' && <DiagnosisView diagnosis={diagnosis.result} onRetry={run} />}
    </>
  );
}

function explainFailure(entry: NetworkEntry, page: string | undefined): { title: string; text?: string } {
  const failure = entry.failure ?? {};
  const target = originOf(entry.url);
  if (failure.aborted) return { title: 'Cancelled', text: 'The app aborted the request before it finished, for example with an AbortController.' };
  if (failure.timeout) return { title: 'Timed out', text: "No answer within the request's timeout." };
  switch (failure.cause) {
    case 'offline':
      return { title: 'The browser is offline', text: 'The request failed while the browser had no network connection.' };
    case 'csp':
      return { title: 'Blocked by Content-Security-Policy', text: `The page's policy does not allow connections to ${target}. Add it to connect-src.` };
    case 'mixed-content':
      return { title: 'Blocked as mixed content', text: `The page is served over HTTPS, so the browser does not let it call ${target} over plain HTTP. Use https:// for this URL.` };
    case 'cross-origin':
      return {
        title: 'Cross-origin request failed',
        text:
          `Browsers do not tell a page why a cross-origin request failed. Usually it is CORS: the server's answer did not allow ${page ? originOf(page) : 'the page'}, but the server may also be unreachable.` +
          (failure.credentials ? ' The request sends cookies, so the server also has to answer with Access-Control-Allow-Credentials: true and cannot allow *.' : ''),
      };
  }
  return { title: 'Request failed' };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function DiagnosisView({ diagnosis, onRetry }: { diagnosis: NetworkDiagnosis; onRetry: () => void }) {
  return (
    <div className={`diagnosis verdict-${diagnosis.verdict}`}>
      <div className="diagnosis-head">
        <strong>{VERDICTS[diagnosis.verdict]}</strong>
        <span className="spacer" />
        <button type="button" className="btn small" onClick={onRetry}>
          Check again
        </button>
      </div>
      <p>{diagnosis.summary}</p>
      {diagnosis.checks.length > 0 && (
        <ul className="checks">
          {diagnosis.checks.map((check, index) => (
            <li key={index} className={`check ${check.outcome}`}>
              <span className="check-mark" aria-label={check.outcome}>
                {check.outcome === 'pass' ? '✓' : check.outcome === 'fail' ? '✕' : '•'}
              </span>
              <span className="check-label">{check.label}</span>
              {check.detail !== diagnosis.summary && <span className="check-detail">{check.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      {diagnosis.sent.length > 0 && (
        <div className="section">
          <h3>Sent from this computer</h3>
          <ul className="sent">
            {diagnosis.sent.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function HeadersTab({ entry }: { entry: NetworkEntry }) {
  const general: Array<[string, string]> = [
    ['URL', entry.url],
    ['Method', entry.method],
    [
      'Status',
      entry.state === 'pending'
        ? 'Pending'
        : entry.state === 'failed'
          ? `Failed: ${entry.error ?? ''}`
          : `${entry.status ?? ''} ${entry.statusText ?? ''}`.trim(),
    ],
    ['Started', formatTime(entry.ts)],
    ['Duration', formatDuration(entry.duration)],
    ['Initiator', entry.initiator],
  ];
  return (
    <>
      <KeyValues title="General" rows={general} />
      {entry.responseHeaders && <KeyValues title="Response headers" rows={Object.entries(entry.responseHeaders)} />}
      <KeyValues title="Request headers" rows={Object.entries(entry.requestHeaders)} empty="No headers set by the app" />
    </>
  );
}

function KeyValues({ title, rows, empty }: { title: string; rows: Array<[string, string]>; empty?: string }) {
  return (
    <div className="section">
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="note">{empty ?? 'None'}</p>
      ) : (
        <dl className="kv">
          {rows.map(([key, value]) => (
            <div key={key} className="kv-row">
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function BodyView({ body, empty, copyable }: { body?: BodyPreview; empty: string; copyable?: boolean }) {
  const [raw, setRaw] = useState(false);
  const parsed = useMemo(() => (body?.text !== undefined ? parseJson(body.text) : { ok: false as const }), [body]);

  if (!body) return <p className="note">{empty}</p>;
  if (body.text === undefined) {
    return (
      <div className="section">
        <p className="note">
          {body.summary ?? body.kind} {body.size !== undefined && `· ${formatBytes(body.size)}`} · not captured as text
        </p>
      </div>
    );
  }

  return (
    <div className="section">
      <div className="body-meta">
        <span className="note">
          {body.contentType ?? (body.kind === 'form' ? 'form data' : 'text')} · {formatBytes(body.size)}
        </span>
        <span className="spacer" />
        {parsed.ok && (
          <button type="button" className="btn small" onClick={() => setRaw(!raw)}>
            {raw ? 'Tree' : 'Raw'}
          </button>
        )}
        {copyable && (
          <CopyButton className="btn small" label="Copy the body" text={() => body.text!}>
            Copy
          </CopyButton>
        )}
      </div>
      {body.truncated && <p className="callout">Truncated by the SDK; only the beginning was captured.</p>}
      {parsed.ok && !raw ? <JsonTree value={parsed.value} raw expandDepth={2} /> : <pre className="code">{body.text}</pre>}
    </div>
  );
}
