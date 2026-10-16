import {
  formatBytes,
  formatLogMessage,
  isExpandable,
  isSpecial,
  makeMatcher,
  valueText,
  type BodyPreview,
  type CapybaraEvent,
  type LogLevel,
  type LogSource,
  type NetworkDiagnosis,
  type NetworkFailureCause,
  type NetworkInitiator,
  type SerializedValue,
  type SessionMeta,
  type StorageAdapterInfo,
  type StorageEntries,
  type StorageEntry,
} from '@capybara-devtools/protocol';

export interface LogEntry {
  seq: number;
  ts: number;
  level: LogLevel;
  source: LogSource;
  args: SerializedValue[];
}

export interface SocketMessage {
  seq: number;
  ts: number;
  direction: 'sent' | 'received';
  data: BodyPreview;
}

export interface RequestEntry {
  id: string;
  seq: number;
  ts: number;
  initiator: NetworkInitiator | 'websocket';
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody?: BodyPreview;
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: BodyPreview;
  /** For WebSockets, how long the connection lasted. */
  duration?: number;
  failure?: { message: string; cause?: NetworkFailureCause; credentials?: boolean; aborted?: boolean; timeout?: boolean };
  socket?: {
    state: 'connecting' | 'open' | 'closed' | 'failed';
    protocol?: string;
    closeCode?: number;
    closeReason?: string;
    error?: string;
    existing?: boolean;
    messages: SocketMessage[];
  };
}

/** Rebuilds logs, requests and sockets from a session's events, as the UI's store does. */
export function readEvents(events: CapybaraEvent[]): { logs: LogEntry[]; requests: RequestEntry[] } {
  const logs: LogEntry[] = [];
  const requests = new Map<string, RequestEntry>();
  for (const event of events) {
    switch (event.kind) {
      case 'log':
        logs.push({ seq: event.seq, ts: event.ts, ...event.payload });
        break;
      case 'network.request': {
        const p = event.payload;
        requests.set(p.id, {
          id: p.id,
          seq: event.seq,
          ts: event.ts,
          initiator: p.initiator,
          method: p.method,
          url: p.url,
          requestHeaders: p.headers,
          requestBody: p.body,
        });
        break;
      }
      case 'network.response': {
        const entry = requests.get(event.payload.id);
        if (!entry) break;
        const p = event.payload;
        entry.status = p.status;
        entry.statusText = p.statusText;
        entry.responseHeaders = p.headers;
        entry.responseBody = p.body;
        entry.duration = p.duration;
        break;
      }
      case 'network.error': {
        const entry = requests.get(event.payload.id);
        if (!entry) break;
        const p = event.payload;
        entry.failure = { message: p.message, cause: p.cause, credentials: p.credentials, aborted: p.aborted, timeout: p.timeout };
        entry.duration = p.duration;
        break;
      }
      case 'ws.connect': {
        const p = event.payload;
        requests.set(p.id, {
          id: p.id,
          seq: event.seq,
          ts: event.ts,
          initiator: 'websocket',
          method: 'WS',
          url: p.url,
          requestHeaders: {},
          socket: { state: 'connecting', existing: p.existing, messages: [] },
        });
        break;
      }
      case 'ws.open': {
        const socket = requests.get(event.payload.id)?.socket;
        if (!socket) break;
        socket.state = 'open';
        socket.protocol = event.payload.protocol || undefined;
        break;
      }
      case 'ws.message':
        requests.get(event.payload.id)?.socket?.messages.push({
          seq: event.seq,
          ts: event.ts,
          direction: event.payload.direction,
          data: event.payload.data,
        });
        break;
      case 'ws.error': {
        const socket = requests.get(event.payload.id)?.socket;
        if (socket) socket.error = event.payload.message;
        break;
      }
      case 'ws.close': {
        const entry = requests.get(event.payload.id);
        if (!entry?.socket) break;
        const p = event.payload;
        entry.socket.state = entry.socket.state === 'open' && p.code !== 1006 && !entry.socket.error ? 'closed' : 'failed';
        entry.socket.closeCode = p.code;
        entry.socket.closeReason = p.reason || undefined;
        entry.duration = p.duration;
        break;
      }
    }
  }
  return { logs, requests: [...requests.values()] };
}

// ---------------------------------------------------------------------------
// Hiding credentials
// ---------------------------------------------------------------------------

export const HIDDEN = '[hidden]';
/** Header, JSON key and storage key names whose values are credentials. */
const SECRET_NAME = /authorization|cookie|token|secret|password|passwd|api[-_]?key|credential/i;
/** Query parameters that commonly carry credentials, e.g. `?token=` on a WebSocket URL. */
const SECRET_PARAM = /token|secret|password|passwd|signature|api[-_]?key|auth|credential/i;

export interface Redactor {
  readonly enabled: boolean;
  headers(headers: Record<string, string> | undefined): Record<string, string>;
  url(url: string): string;
  /** A captured log value, before it is formatted. */
  value(value: SerializedValue): SerializedValue;
  /** Plain JSON, e.g. a parsed body or storage value. */
  json(value: unknown): unknown;
  /** Text that may be JSON or a form; anything else is left as it is. */
  text(text: string): string;
}

export function redactor(enabled: boolean): Redactor {
  const params = (text: string) =>
    text.replace(/([?&]|^)([^=&#?\s]+)=([^&#\s]*)/g, (match, separator: string, name: string) =>
      SECRET_PARAM.test(decode(name)) ? `${separator}${name}=${HIDDEN}` : match,
    );
  const json = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(json);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_NAME.test(key) ? HIDDEN : json(item)]));
  };
  const record = (props: Record<string, SerializedValue>) =>
    Object.fromEntries(Object.entries(props).map(([key, item]) => [key, SECRET_NAME.test(key) ? HIDDEN : value(item)]));
  const value = (item: SerializedValue): SerializedValue => {
    if (item === null || typeof item !== 'object') return item;
    if (Array.isArray(item)) return item.map(value);
    if (!isSpecial(item)) return record(item as Record<string, SerializedValue>);
    switch (item.$t) {
      case 'object':
        return { ...item, props: record(item.props) };
      case 'array':
        return { ...item, items: item.items.map(value) };
      case 'set':
        return { ...item, values: item.values.map(value) };
      case 'map':
        return {
          ...item,
          entries: item.entries.map(([key, entry]): [SerializedValue, SerializedValue] => [
            key,
            typeof key === 'string' && SECRET_NAME.test(key) ? HIDDEN : value(entry),
          ]),
        };
      case 'error':
        return item.props ? { ...item, props: record(item.props) } : item;
      default:
        return item;
    }
  };
  if (!enabled) {
    return { enabled, headers: (headers) => headers ?? {}, url: (url) => url, value: (item) => item, json: (item) => item, text: (text) => text };
  }
  return {
    enabled,
    headers: (headers) =>
      Object.fromEntries(Object.entries(headers ?? {}).map(([name, item]) => [name, SECRET_NAME.test(name) ? HIDDEN : item])),
    url: (url) => {
      const withoutPassword = url.replace(/([a-z]+:\/\/[^:/@\s]+):[^@/\s]+@/i, `$1:${HIDDEN}@`);
      const query = withoutPassword.indexOf('?');
      return query < 0 ? withoutPassword : withoutPassword.slice(0, query) + params(withoutPassword.slice(query));
    },
    value,
    json,
    text: (text) => {
      const parsed = parseJson(text);
      if (parsed.ok) return JSON.stringify(json(parsed.value));
      return /^[^=&\s]+=[^&\s]*(&[^=&\s]+=[^&\s]*)*$/.test(text.trim()) ? params(text.trim()) : text;
    },
  };
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** The session a tool reads: the one asked for, else the newest app still connected. */
export function pickSession(sessions: SessionMeta[], id: string | undefined): SessionMeta {
  if (id) {
    const found = sessions.find((session) => session.info.id === id);
    if (found) return found;
    throw new Error(`There is no session ${id}.${sessions.length > 0 ? ` Sessions:\n${sessions.map(sessionLine).join('\n')}` : ''}`);
  }
  const [newest] = [...sessions].sort((a, b) => Number(b.connected) - Number(a.connected) || b.info.startedAt - a.info.startedAt);
  if (!newest) {
    throw new Error(
      'No app has connected to Capybara yet. Start a web app that calls init() from @capybara-devtools/web, or a React Native app through Metro.',
    );
  }
  return newest;
}

export function sessionLine(session: SessionMeta): string {
  const { info } = session;
  const where = info.url ? hostOf(info.url) : [info.device?.model, info.device?.osVersion].filter(Boolean).join(' ');
  const parts = [
    `${info.appName} (${info.platform}${where ? `, ${where}` : ''})`,
    info.runtime,
    session.connected ? 'connected' : 'disconnected',
    `${session.eventCount} events`,
    `started ${clock(info.startedAt)}`,
  ];
  return `- ${info.id}: ${parts.filter(Boolean).join(' · ')}`;
}

export function sessionHeader(session: SessionMeta): string {
  return `${session.info.appName} (session ${session.info.id}${session.connected ? '' : ', disconnected'})`;
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

const SOURCE_LABELS: Record<LogSource, string | null> = {
  console: null,
  api: 'api',
  uncaught: 'uncaught',
  unhandledrejection: 'unhandled rejection',
};

export interface LogQuery {
  level?: LogLevel[];
  search?: string;
  source?: LogSource;
  after?: number;
  before?: number;
}

export function filterLogs(logs: LogEntry[], query: LogQuery, redact: Redactor): LogEntry[] {
  const matcher = searchMatcher(query.search);
  return logs.filter((entry) => {
    if (query.level && !query.level.includes(entry.level)) return false;
    if (query.source && entry.source !== query.source) return false;
    if (query.after !== undefined && entry.seq <= query.after) return false;
    if (query.before !== undefined && entry.seq >= query.before) return false;
    if (!matcher) return true;
    const args = entry.args.map(redact.value);
    return matcher.test(`${formatLogMessage(args)}\n${JSON.stringify(args)}`);
  });
}

/** One log entry: its line, then (in full) each object and error, or (in a list) the top of each stack. */
export function logText(entry: LogEntry, redact: Redactor, full: boolean): string {
  const args = entry.args.map(redact.value);
  const source = SOURCE_LABELS[entry.source];
  const head = `#${entry.seq} ${clock(entry.ts)} ${entry.level.toUpperCase().padEnd(5)} ${source ? `(${source}) ` : ''}${formatLogMessage(args)}`;
  const details = full
    ? args.filter((arg) => isExpandable(arg) || (isSpecial(arg) && arg.$t === 'string')).map((arg) => valueText(arg))
    : args.flatMap((arg) => (isSpecial(arg) && arg.$t === 'error' && arg.stack ? [stackTop(arg.stack, arg.message)] : []));
  return [head, ...details.filter(Boolean).map((detail) => indent(detail, '    '))].join('\n');
}

function stackTop(stack: string, message: string): string {
  const frames = stack.split('\n').filter((line) => line.trim() && !line.includes(message));
  return frames.slice(0, 3).map((line) => line.trim()).join('\n');
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export interface NetworkQuery {
  search?: string;
  method?: string;
  status?: string;
  errors?: boolean;
  type?: RequestEntry['initiator'];
  minDuration?: number;
  after?: number;
  before?: number;
}

export function filterRequests(requests: RequestEntry[], query: NetworkQuery, redact: Redactor): RequestEntry[] {
  const matcher = searchMatcher(query.search);
  const status = statusFilter(query.status);
  return requests.filter((entry) => {
    if (query.method && entry.method.toUpperCase() !== query.method.toUpperCase()) return false;
    if (query.type && entry.initiator !== query.type) return false;
    if (query.errors && !isError(entry)) return false;
    if (status && !status(entry)) return false;
    if (query.minDuration !== undefined && (entry.duration ?? 0) < query.minDuration) return false;
    if (query.after !== undefined && entry.seq <= query.after) return false;
    if (query.before !== undefined && entry.seq >= query.before) return false;
    return !matcher || matcher.test(`${entry.method} ${redact.url(entry.url)}`);
  });
}

function isError(entry: RequestEntry): boolean {
  return !!entry.failure || (entry.status ?? 0) >= 400 || entry.socket?.state === 'failed';
}

function statusFilter(spec: string | undefined): ((entry: RequestEntry) => boolean) | undefined {
  const value = spec?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === 'failed') return (entry) => !!entry.failure || entry.socket?.state === 'failed';
  if (value === 'pending') return (entry) => entry.status === undefined && !entry.failure && (!entry.socket || entry.socket.state === 'connecting');
  const range = /^([1-5])xx$/.exec(value);
  if (range) return (entry) => Math.floor((entry.status ?? 0) / 100) === Number(range[1]);
  if (/^\d{3}$/.test(value)) return (entry) => entry.status === Number(value);
  throw new Error(`Unknown status filter "${spec}". Use a status such as 404, a class such as 4xx or 5xx, "failed" or "pending".`);
}

export function requestLine(entry: RequestEntry, redact: Redactor): string {
  const columns = [
    entry.id,
    clock(entry.ts),
    entry.method.padEnd(6),
    statusLabel(entry).padEnd(8),
    duration(entry.duration).padStart(8),
    entry.initiator.padEnd(9),
    redact.url(entry.url),
  ];
  return columns.join('  ') + requestNote(entry);
}

function statusLabel(entry: RequestEntry): string {
  if (entry.socket) return entry.socket.closeCode !== undefined ? `${entry.socket.state} ${entry.socket.closeCode}` : entry.socket.state;
  if (entry.failure) return entry.failure.aborted ? 'aborted' : entry.failure.timeout ? 'timeout' : 'failed';
  return entry.status === undefined ? 'pending' : String(entry.status);
}

function requestNote(entry: RequestEntry): string {
  if (entry.failure) return `  ← ${entry.failure.message}${entry.failure.cause ? ` [${entry.failure.cause}]` : ''}`;
  if (entry.socket) {
    const parts = [`${entry.socket.messages.length} messages`, entry.socket.error, entry.socket.closeReason].filter(Boolean);
    return `  ← ${parts.join(', ')}`;
  }
  return '';
}

export type BodyMode = 'none' | 'preview' | 'full';
const BODY_PREVIEW = 4_000;

export function requestDetail(entry: RequestEntry, redact: Redactor, body: BodyMode): string {
  const lines = [`${entry.method} ${redact.url(entry.url)}`];
  const status = entry.socket
    ? statusLabel(entry)
    : entry.failure
      ? statusLabel(entry)
      : entry.status === undefined
        ? 'pending'
        : `${entry.status}${entry.statusText ? ` ${entry.statusText}` : ''}`;
  lines.push(`Status: ${status} · ${duration(entry.duration)} · ${entry.initiator} · started ${clock(entry.ts)} · request id ${entry.id}`);
  if (entry.failure) {
    const cause = entry.failure.cause ? ` (${entry.failure.cause})` : '';
    lines.push(`Failed: ${entry.failure.message}${cause}${entry.failure.credentials ? '; the request sent cookies' : ''}.`);
    if (entry.failure.cause === 'cross-origin') lines.push('Call diagnose_request with this id to find out why.');
  }
  if (entry.socket) {
    const socket = entry.socket;
    if (socket.protocol) lines.push(`Subprotocol: ${socket.protocol}`);
    if (socket.error) lines.push(`Error: ${socket.error}`);
    if (socket.existing) lines.push('Already open when Capybara attached, so earlier messages are missing.');
    lines.push(`${socket.messages.length} messages; call get_websocket with this id to read them.`);
    return lines.join('\n');
  }
  lines.push('', 'Request headers:', ...headerLines(redact.headers(entry.requestHeaders)));
  if (body !== 'none') lines.push('', `Request body${bodyMeta(entry.requestBody)}:`, indent(bodyText(entry.requestBody, redact, body), '  '));
  if (entry.responseHeaders) lines.push('', 'Response headers:', ...headerLines(redact.headers(entry.responseHeaders)));
  if (body !== 'none' && (entry.responseHeaders || entry.responseBody)) {
    lines.push('', `Response body${bodyMeta(entry.responseBody)}:`, indent(bodyText(entry.responseBody, redact, body), '  '));
  }
  return lines.join('\n');
}

function headerLines(headers: Record<string, string>): string[] {
  const entries = Object.entries(headers);
  return entries.length === 0 ? ['  (none set by the app)'] : entries.map(([name, value]) => `  ${name}: ${value}`);
}

function bodyMeta(body: BodyPreview | undefined): string {
  if (!body) return '';
  const parts = [body.contentType, body.size === undefined ? undefined : formatBytes(body.size)].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function bodyText(body: BodyPreview | undefined, redact: Redactor, mode: BodyMode): string {
  if (!body) return '(none)';
  if (body.text === undefined) return body.summary ?? `(${body.kind})`;
  const parsed = parseJson(body.text);
  const text = parsed.ok ? JSON.stringify(redact.json(parsed.value), null, 2) : redact.text(body.text);
  const cut = mode === 'preview' ? truncate(text, BODY_PREVIEW) : text;
  return body.truncated ? `${cut}\n(the app captured only the beginning of this body)` : cut;
}

// ---------------------------------------------------------------------------
// WebSockets
// ---------------------------------------------------------------------------

export interface SocketQuery {
  direction?: 'sent' | 'received';
  search?: string;
  after?: number;
}

export function filterMessages(messages: SocketMessage[], query: SocketQuery, redact: Redactor): SocketMessage[] {
  const matcher = searchMatcher(query.search);
  return messages.filter((message) => {
    if (query.direction && message.direction !== query.direction) return false;
    if (query.after !== undefined && message.seq <= query.after) return false;
    return !matcher || matcher.test(messageText(message, redact));
  });
}

export function messageLine(message: SocketMessage, redact: Redactor): string {
  const arrow = message.direction === 'sent' ? '→ sent    ' : '← received';
  return `#${message.seq} ${clock(message.ts)} ${arrow} ${truncate(messageText(message, redact), 600)}`;
}

function messageText(message: SocketMessage, redact: Redactor): string {
  const { data } = message;
  if (data.text === undefined) return `${data.summary ?? data.kind}${data.size === undefined ? '' : ` (${formatBytes(data.size)})`}`;
  return redact.text(data.text);
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export function adapterLine(adapter: StorageAdapterInfo, keys: number | undefined): string {
  const notes = [keys === undefined ? undefined : `${keys} ${keys === 1 ? 'key' : 'keys'}`, adapter.readOnly ? 'read-only' : undefined, adapter.note].filter(Boolean);
  return `- ${adapter.id}: ${adapter.label}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`;
}

export function storageValueText(key: string, value: string | null, redact: Redactor, pretty: boolean): string {
  if (value === null) return 'null';
  if (redact.enabled && SECRET_NAME.test(key)) return HIDDEN;
  const parsed = parseJson(value);
  if (!parsed.ok) return redact.text(value);
  return JSON.stringify(redact.json(parsed.value), null, pretty ? 2 : undefined);
}

export function storageEntryLines(listing: StorageEntries, redact: Redactor, search: string | undefined): { lines: string[]; matched: number } {
  const matcher = searchMatcher(search);
  const lines: string[] = [];
  let matched = 0;
  for (const entry of listing.entries) {
    const text = storageValueText(entry.key, entry.value, redact, false);
    if (matcher && !matcher.test(`${entry.key}\n${text}`)) continue;
    matched++;
    lines.push(`- ${entry.key} (${formatBytes(entry.size)}): ${truncate(text, 300)}`);
  }
  return { lines, matched };
}

export function storageEntryText(entry: StorageEntry, redact: Redactor): string {
  const note = entry.truncated ? '\n(only the beginning of this value was read)' : '';
  return `${entry.key} (${formatBytes(entry.size)}):\n${storageValueText(entry.key, entry.value, redact, true)}${note}`;
}

// ---------------------------------------------------------------------------
// Diagnosis
// ---------------------------------------------------------------------------

export function diagnosisText(entry: RequestEntry, diagnosis: NetworkDiagnosis, redact: Redactor): string {
  const marks = { pass: '✓', fail: '✗', info: '•' } as const;
  const lines = [
    `${entry.method} ${redact.url(entry.url)}`,
    `Verdict: ${diagnosis.verdict}. ${diagnosis.summary}`,
  ];
  if (diagnosis.checks.length > 0) {
    lines.push('', 'Checks:', ...diagnosis.checks.map((check) => `  ${marks[check.outcome]} ${check.label}: ${check.detail}`));
  }
  if (diagnosis.sent.length > 0) {
    lines.push('', 'Sent from this computer, without the app\'s cookies or Authorization header:', ...diagnosis.sent.map((line) => `  ${redact.url(line)}`));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** The newest `limit` items, and a note on the older ones left out. */
export function newest<T extends { seq: number }>(items: T[], limit: number): { shown: T[]; omitted: number } {
  const shown = items.slice(-limit);
  return { shown, omitted: items.length - shown.length };
}

function searchMatcher(search: string | undefined) {
  if (!search) return null;
  const matcher = makeMatcher(search);
  if (matcher?.invalid) throw new Error(`Invalid regular expression: ${search}`);
  return matcher;
}

export function clock(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function duration(ms: number | undefined): string {
  if (ms === undefined) return '-';
  return ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(2)} s`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (${(text.length - max).toLocaleString('en-US')} more characters)` : text;
}

function indent(text: string, prefix: string): string {
  return text.replace(/^/gm, prefix);
}
