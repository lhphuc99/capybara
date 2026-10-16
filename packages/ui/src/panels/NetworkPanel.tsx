import type { BodyPreview } from '@devsight/protocol';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { JsonTree } from '../components/JsonTree';
import {
  copyText,
  formatBytes,
  formatDuration,
  formatTime,
  makeMatcher,
  parseJson,
  responseSize,
  splitUrl,
  statusTone,
  toCurl,
} from '../format';
import { clearSession, type NetworkEntry, type SessionState } from '../store';

type Filter = 'all' | 'fetch' | 'xhr' | 'failed';
type DetailTab = 'headers' | 'request' | 'response';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'fetch', label: 'Fetch' },
  { id: 'xhr', label: 'XHR' },
  { id: 'failed', label: 'Failed' },
];

const ROW_HEIGHT = 26;

export function NetworkPanel({ session }: { session: SessionState }) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { network } = session;

  const matcher = useMemo(() => makeMatcher(query), [query]);
  const visible = useMemo(
    () =>
      network.filter((entry) => {
        if (filter === 'fetch' || filter === 'xhr') {
          if (entry.initiator !== filter) return false;
        } else if (filter === 'failed' && statusTone(entry) !== 'error') {
          return false;
        }
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

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (follow && body) body.scrollTop = body.scrollHeight;
  });

  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedId(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected]);

  const onScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < ROW_HEIGHT;
    if (atBottom !== follow) setFollow(atBottom);
  };

  return (
    <section className="panel">
      <div className="toolbar">
        <input
          className={`search${matcher?.invalid ? ' invalid' : ''}`}
          placeholder="Filter by URL, method or status"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          spellCheck={false}
        />
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

      <div className={`network${selected ? ' with-detail' : ''}`}>
        <div className="net-table">
          <div className="net-head">
            <span>Status</span>
            <span>Method</span>
            <span>Path</span>
            <span>Host</span>
            <span>Type</span>
            <span className="num">Size</span>
            <span className="num">Time</span>
          </div>
          {network.length === 0 ? (
            <div className="empty">
              <strong>No requests yet</strong>
              <p>Requests made with fetch, XMLHttpRequest or axios show up here.</p>
            </div>
          ) : (
            <div className="net-body" ref={bodyRef} onScroll={onScroll}>
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
        {selected && <RequestDetail entry={selected} onClose={() => setSelectedId(null)} />}
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
        {entry.state === 'pending' ? 'pending' : entry.state === 'failed' ? 'failed' : entry.status}
      </span>
      <span>{entry.method}</span>
      <span className="net-path">{path || '/'}</span>
      <span className="muted">{host}</span>
      <span className="muted">{entry.initiator}</span>
      <span className="num muted">{formatBytes(responseSize(entry))}</span>
      <span className="num">{formatDuration(entry.duration)}</span>
    </div>
  );
}

function RequestDetail({ entry, onClose }: { entry: NetworkEntry; onClose: () => void }) {
  const [tab, setTab] = useState<DetailTab>('response');
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (label: string, text: string) => {
    void copyText(text).then(() => {
      setCopied(label);
      window.setTimeout(() => setCopied(null), 1_200);
    });
  };

  return (
    <aside className="detail">
      <div className="detail-head">
        <div className="subtabs" role="tablist">
          {(['headers', 'request', 'response'] as const).map((id) => (
            <button key={id} type="button" role="tab" className="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {id === 'headers' ? 'Headers' : id === 'request' ? 'Request' : 'Response'}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button type="button" className="btn small" onClick={() => copy('curl', toCurl(entry))}>
          {copied === 'curl' ? 'Copied' : 'Copy cURL'}
        </button>
        <button type="button" className="btn small icon" onClick={onClose} aria-label="Close details">
          ✕
        </button>
      </div>
      <div className="detail-body">
        {tab === 'headers' && <HeadersTab entry={entry} />}
        {tab === 'request' && <BodyView body={entry.requestBody} empty="No request body" />}
        {tab === 'response' &&
          (entry.state === 'failed' ? (
            <div className="callout error">
              <strong>Request failed</strong>
              <p>{entry.error}</p>
            </div>
          ) : entry.state === 'pending' ? (
            <p className="note">Waiting for the response…</p>
          ) : (
            <BodyView body={entry.responseBody} empty="No response body" onCopy={(text) => copy('body', text)} copied={copied === 'body'} />
          ))}
      </div>
    </aside>
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

function BodyView({
  body,
  empty,
  onCopy,
  copied,
}: {
  body?: BodyPreview;
  empty: string;
  onCopy?: (text: string) => void;
  copied?: boolean;
}) {
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
        {onCopy && (
          <button type="button" className="btn small" onClick={() => onCopy(body.text!)}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
      {body.truncated && <p className="callout">Truncated by the SDK; only the beginning was captured.</p>}
      {parsed.ok && !raw ? <JsonTree value={parsed.value} raw expandDepth={2} /> : <pre className="code">{body.text}</pre>}
    </div>
  );
}
