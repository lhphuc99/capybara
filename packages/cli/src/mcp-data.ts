import {
  formatBytes,
  formatLogMessage,
  formatOp,
  formatPath,
  isExpandable,
  isSpecial,
  libraryTitle,
  makeMatcher,
  METRO_SDK,
  plainValue,
  preview,
  STATE_LIBRARIES,
  stateChangeLabel,
  valueText,
  type BodyPreview,
  type CapybaraEvent,
  type LogLevel,
  type LogSource,
  type NetworkDiagnosis,
  type NetworkFailureCause,
  type NetworkInitiator,
  type SerializedValue,
  type SessionInfo,
  type SessionMeta,
  type StateChangePayload,
  type StateCommands,
  type StateDiffOp,
  type StateEntrySummary,
  type StateLibrary,
  type StatePath,
  type StateStoreInfo,
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
const SECRET_NAME = /authorization|cookie|token|secret|password|passwd|api[-_]?key|credential|jwt|bearer|private[-_]?key/i;
/** Query parameters that commonly carry credentials, e.g. `?token=` on a WebSocket URL. */
const SECRET_PARAM = /token|secret|password|passwd|signature|api[-_]?key|auth|credential/i;
/** Credentials known by their shape alone: JWTs, `Bearer …`, and Stripe, GitHub, Slack and AWS keys. */
const SECRET_VALUE =
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}|\bBearer\s+[\w.~+/-]{8,}=*|\b[sr]k_(?:live|test)_\w{8,}|\bgh[pousr]_\w{20,}|\bxox[abprs]-[\w-]{10,}|\bAKIA[0-9A-Z]{16}\b/g;

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
  /** Free text such as a query key or an error message, where no key name tells a credential apart. */
  tokens(text: string): string;
}

/**
 * What a credential's key holds when there is no credential, as while signed out. Shown as it is, so
 * `token: null` reads differently from a hidden token.
 */
function isUnset(value: unknown): boolean {
  const item = value as SerializedValue;
  return item === null || item === undefined || item === false || item === '' || (isSpecial(item) && item.$t === 'undefined');
}

export function redactor(enabled: boolean): Redactor {
  const params = (text: string) =>
    text.replace(/([?&]|^)([^=&#?\s]+)=([^&#\s]*)/g, (match, separator: string, name: string, item: string) =>
      SECRET_PARAM.test(decode(name)) && !isUnset(item) ? `${separator}${name}=${HIDDEN}` : match,
    );
  const json = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(json);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, SECRET_NAME.test(key) && !isUnset(item) ? HIDDEN : json(item)]),
    );
  };
  const record = (props: Record<string, SerializedValue>) =>
    Object.fromEntries(
      Object.entries(props).map(([key, item]) => [key, SECRET_NAME.test(key) && !isUnset(item) ? HIDDEN : value(item)]),
    );
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
            typeof key === 'string' && SECRET_NAME.test(key) && !isUnset(entry) ? HIDDEN : value(entry),
          ]),
        };
      case 'error':
        return item.props ? { ...item, props: record(item.props) } : item;
      default:
        return item;
    }
  };
  if (!enabled) {
    const same = <T>(item: T) => item;
    return { enabled, headers: (headers) => headers ?? {}, url: same, value: same, json: same, text: same, tokens: same };
  }
  return {
    enabled,
    headers: (headers) =>
      Object.fromEntries(
        Object.entries(headers ?? {}).map(([name, item]) => [name, SECRET_NAME.test(name) && !isUnset(item) ? HIDDEN : item]),
      ),
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
    tokens: (text) => text.replace(SECRET_VALUE, HIDDEN),
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
  if (redact.enabled && SECRET_NAME.test(key) && !isUnset(value)) return HIDDEN;
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
// State
// ---------------------------------------------------------------------------

/** One `state.change`: what an action (or a direct set) changed in a store. */
export interface ChangeEntry {
  seq: number;
  ts: number;
  store: string;
  rev: number;
  cause: StateChangePayload['cause'];
  action?: StateChangePayload['action'];
  ops: StateDiffOp[];
  /** Changes in the record, counting those the app cut from `ops`. */
  opCount: number;
  /** Changes the app folded into this one, by its rate limit or while it was offline. */
  skipped: number;
  /** Changes lost just before this one, seen as a jump in `rev`. */
  missed: number;
}

export interface StoreEntry {
  info: StateStoreInfo;
  /** Its changes in the history. */
  changes: number;
  last?: ChangeEntry;
}

export interface StateHistory {
  /** By id, in the order the history first names them. */
  stores: Map<string, StoreEntry>;
  /** Oldest first. */
  changes: ChangeEntry[];
}

/** Rebuilds the stores and their changes from a session's events, counting skipped and missed changes as the UI does. */
export function readStateEvents(events: CapybaraEvent[]): StateHistory {
  const stores = new Map<string, StoreEntry>();
  const changes: ChangeEntry[] = [];
  for (const event of events) {
    if (event.kind === 'state.store') {
      const info = event.payload?.store;
      if (typeof info?.id !== 'string') continue;
      // The server keeps each store's latest registration at its own seq, often after the store's changes.
      const known = stores.get(info.id);
      if (known) known.info = info;
      else stores.set(info.id, { info, changes: 0 });
    } else if (event.kind === 'state.change') {
      const p = event.payload;
      if (typeof p?.store !== 'string' || typeof p.rev !== 'number') continue;
      let store = stores.get(p.store);
      if (!store) {
        store = { info: standIn(p.store, Boolean(p.action)), changes: 0 };
        stores.set(p.store, store);
      }
      const ops = Array.isArray(p.ops) ? p.ops.filter((op) => Array.isArray(op?.path)) : [];
      const previous = store.last?.rev ?? 0;
      const entry: ChangeEntry = {
        seq: event.seq,
        ts: event.ts,
        store: p.store,
        rev: p.rev,
        cause: p.cause,
        action: p.action,
        ops,
        opCount: Math.max(typeof p.opCount === 'number' ? p.opCount : 0, ops.length),
        skipped: typeof p.skipped === 'number' && p.skipped > 0 ? p.skipped : 0,
        // A lower rev means the app started counting again, not that changes were lost.
        missed: previous > 0 && p.rev > previous + 1 ? p.rev - previous - 1 : 0,
      };
      changes.push(entry);
      store.changes++;
      store.last = entry;
    }
  }
  return { stores, changes };
}

/** A store only seen in changes, e.g. when the server restarted while the app kept running. */
function standIn(id: string, actions: boolean): StateStoreInfo {
  return { id, library: id.split(':')[0] as StateLibrary, label: id, via: 'subscribe', actions };
}

/** The history's stores with the ones the app has now laid over them. */
export function mergeStores(history: StateHistory, current: StateStoreInfo[]): StoreEntry[] {
  const merged = new Map(history.stores);
  for (const info of current) {
    const known = merged.get(info.id);
    merged.set(info.id, known ? { ...known, info } : { info, changes: 0 });
  }
  return [...merged.values()];
}

/**
 * Stores grouped by library in the UI's order, by the UI's rules. Of stores sharing a name only the newest live one
 * is listed: hot reloading leaves the old instances behind, disposed or not (the browser keeps old modules alive).
 * Context providers may share a label legitimately, so they are not thinned. Contexts that belong to a library
 * (`vendor`) are left out as the UI hides them; `findStore` still finds them.
 */
export function listStores(stores: StoreEntry[]): { shown: StoreEntry[]; replaced: number; vendored: number } {
  const nameOf = (info: StateStoreInfo) => `${info.library}\n${info.label}`;
  const number = (info: StateStoreInfo) => Number(info.id.slice(info.id.lastIndexOf(':') + 1)) || 0;
  const newest = new Map<string, number>();
  for (const { info } of stores) {
    if (info.disposed || info.library === 'context') continue;
    newest.set(nameOf(info), Math.max(newest.get(nameOf(info)) ?? 0, number(info)));
  }
  const live = new Set(stores.filter((store) => !store.info.disposed).map((store) => nameOf(store.info)));
  const current = stores.filter(({ info }) =>
    info.disposed ? !live.has(nameOf(info)) : info.library === 'context' || number(info) === newest.get(nameOf(info)),
  );
  const kept = current.filter(({ info }) => !info.vendor);
  const rank = (library: string) => {
    const index = STATE_LIBRARIES.indexOf(library as StateLibrary);
    return index < 0 ? STATE_LIBRARIES.length : index;
  };
  const shown = [...kept].sort((a, b) => rank(a.info.library) - rank(b.info.library));
  return { shown, replaced: stores.length - current.length, vendored: current.length - kept.length };
}

/**
 * The store with this id, else with this label: live ones before disposed ones, and of several in one
 * library (hot reloading), the newest. `others` counts the rest it was picked from. Undefined when nothing matches.
 */
export function findStore(stores: StoreEntry[], name: string): { store: StoreEntry; others: number } | undefined {
  const byId = stores.find((store) => store.info.id === name);
  if (byId) return { store: byId, others: 0 };
  let named = stores.filter((store) => store.info.label === name);
  if (named.length === 0) named = stores.filter((store) => store.info.label.toLowerCase() === name.toLowerCase());
  if (named.length === 0) return undefined;
  const live = named.filter((store) => !store.info.disposed);
  const pool = live.length > 0 ? live : named;
  if (new Set(pool.map((store) => store.info.library)).size > 1) {
    const list = pool.map((store) => `${store.info.id} (${libraryTitle(store.info.library)})`).join(', ');
    throw new Error(`"${name}" names ${pool.length} stores: ${list}. Pass the id instead.`);
  }
  // Ids count up per library ("redux:2"), so the highest is the newest; anything else keeps the later one.
  const order = (store: StoreEntry) => Number(/:(\d+)$/.exec(store.info.id)?.[1] ?? Number.NaN);
  const store = pool.reduce((newest, next) => (order(next) < order(newest) ? newest : next));
  return { store, others: pool.length - 1 };
}

export function unknownStore(stores: StoreEntry[], name: string, session: SessionMeta): Error {
  const { shown } = listStores(stores);
  if (shown.length === 0) return new Error(`There is no store "${name}": ${noStoresText(session)}`);
  return new Error(`There is no store "${name}" in ${sessionHeader(session)}. Its stores:\n${shown.map((store) => storeLine(store)).join('\n')}`);
}

/** Whether the session's SDK runs the state plugin, so the app can be asked about its stores. */
export function reportsState(info: SessionInfo): boolean {
  return info.plugins?.includes('state') === true;
}

const LIBRARY_NAMES = 'Redux, Zustand, TanStack Query, SWR or React Context';

/** Why a session shows no stores, in the UI's words. */
export function noStoresText(session: SessionMeta): string {
  const { info } = session;
  const name = sessionHeader(session);
  if (!reportsState(info)) {
    if (info.sdk.name === METRO_SDK) {
      return (
        `${name} is read through Metro without the SDK, which shows logs, network and storage but not ${LIBRARY_NAMES} state. ` +
        'Add the SDK to the app to see its stores.'
      );
    }
    if (!info.plugins) {
      return `${name} uses ${info.sdk.name} ${info.sdk.version}, which does not report ${LIBRARY_NAMES} state. Update it to the latest version.`;
    }
    return (
      `${name} runs ${info.sdk.name} ${info.sdk.version} without its state plugin. ` +
      'Remove `state: false` from the options passed to init(), or update the SDK if this version came before state.'
    );
  }
  if (!session.connected) return `${name} is not connected, and its history has no state stores.`;
  return (
    `${name} has no state stores yet. ${LIBRARY_NAMES} stores show up once the app registers them; ` +
    'keep init() in the first file the app imports, before its store modules load.'
  );
}

/** TanStack Query and SWR stores hold cache entries; the others have a state and a timeline of changes. */
export function isCache(info: StateStoreInfo): boolean {
  return info.library === 'tanstack-query' || info.library === 'swr' || info.ops !== undefined;
}

/** `cart (Redux, redux:1)`. */
export function storeTitle(info: StateStoreInfo): string {
  const notes = [libraryTitle(info.library), info.label === info.id ? undefined : info.id, info.disposed ? 'disposed' : undefined];
  return `${info.label} (${notes.filter(Boolean).join(', ')})`;
}

/** One store in a list; `listing` is a cache's entries, read from the app. */
export function storeLine(store: StoreEntry, listing?: StateCommands['entries']['result']): string {
  const { info, last } = store;
  const parts = [`- ${info.id}: ${info.label} (${libraryTitle(info.library)}${info.disposed ? ', disposed' : ''})`];
  if (isCache(info)) {
    if (listing) parts.push(...cacheCounts(info, listing));
  } else if (last) {
    const label = stateChangeLabel(last).text;
    const recorded = count(store.changes, info.actions ? 'action' : 'change');
    parts.push(`${recorded} recorded, the last #${last.seq} ${label} at ${clock(last.ts)} (rev ${last.rev})`);
  } else {
    parts.push('no changes recorded');
  }
  if (info.note) parts.push(info.note);
  return parts.join(' · ');
}

/** The stores `listStores` picked, `listings` holding the entries read for each cache. */
export function storeListText(
  session: SessionMeta,
  list: { shown: StoreEntry[]; replaced: number; vendored: number },
  listings: Array<StateCommands['entries']['result'] | undefined>,
  failure: string | undefined,
): string {
  if (list.shown.length === 0) return noStoresText(session);
  const name = sessionHeader(session);
  const head = !session.connected
    ? `${name} is not connected, so the current state of its stores cannot be read. The stores it registered:`
    : failure
      ? `${name} did not list its stores (${failure}). The stores in its history:`
      : `${name} state stores:`;
  const lines = [head, ...list.shown.map((store, index) => storeLine(store, listings[index]))];
  if (list.replaced > 0) lines.push(`${count(list.replaced, 'older store')} replaced by a newer one of the same name not listed.`);
  if (list.vendored > 0) lines.push(`${count(list.vendored, 'library context')} (e.g. React Redux, TanStack Query) not listed; pass its label as store to read one.`);
  if (!session.connected) {
    lines.push('get_state_actions reads the changes recorded before it disconnected.');
  } else {
    const caches = list.shown.some((store) => isCache(store.info)) ? ', and get_queries the TanStack Query and SWR entries' : '';
    lines.push(`Pass store (an id or label) to read its current state; get_state_actions lists what changed${caches}.`);
  }
  return lines.join('\n');
}

/** What a read shows: the change the app had recorded last when it read, named from the history while it is there. */
export function readAsOf(history: StateHistory, info: StateStoreInfo, read: StateCommands['get']['result'], path: StatePath): string {
  let text = path.length > 0 ? `Value at ${formatPath(path)}` : 'Current state';
  if (read.rev > 0) {
    let change: ChangeEntry | undefined;
    for (let i = history.changes.length - 1; i >= 0 && !change; i--) {
      const candidate = history.changes[i]!;
      if (candidate.store === info.id && candidate.rev === read.rev) change = candidate;
    }
    text += ` as of rev ${read.rev}${change ? ` (#${change.seq} ${stateChangeLabel(change).text} at ${clock(change.ts)})` : ''}`;
  }
  return `${text}${read.pending ? ', with newer changes on the way' : ''}:`;
}

function cacheCounts(info: StateStoreInfo, listing: StateCommands['entries']['result']): string[] {
  const { entries, total } = listing;
  const mutations = entries.filter((entry) => entry.kind === 'mutation').length;
  const listed =
    info.library === 'tanstack-query'
      ? `${count(entries.length - mutations, 'query', 'queries')}, ${count(mutations, 'mutation')}`
      : count(entries.length, 'key');
  const parts = [total > entries.length ? `${listed} (${total} in the app)` : listed];
  const errors = entries.filter((entry) => entry.status === 'error').length;
  const fetching = entries.filter((entry) => entry.fetching).length;
  if (errors > 0) parts.push(`${errors} in error`);
  if (fetching > 0) parts.push(`${fetching} fetching`);
  return parts;
}

/** A path through a key named like a credential leads to the credential, or to something holding it. */
function secretPath(path: StatePath): boolean {
  return path.some((key) => typeof key === 'string' && SECRET_NAME.test(key));
}

/** The app's errors for a read, said in terms of the store and path asked for. */
export function stateReadError(error: unknown, info: StateStoreInfo, path: StatePath, what: 'state' | 'entries' | 'data'): Error {
  const text = error instanceof Error ? error.message : String(error);
  if (text.startsWith('Unknown store ')) return new Error(`The app no longer has ${storeTitle(info)}, so its ${what} cannot be read.`);
  if (text.startsWith('Nothing at ')) {
    const whole = what === 'data' ? 'all of its data' : 'the whole state';
    return new Error(`${storeTitle(info)} has nothing at ${formatPath(path)}${what === 'data' ? ' in this entry' : ''}. Leave out path to read ${whole}.`);
  }
  return error instanceof Error ? error : new Error(text);
}

/** A value read from the app, credentials hidden, cut at `maxChars`, with how to read the parts left out. */
export function readValueText(read: { value: SerializedValue; truncated: boolean }, path: StatePath, redact: Redactor, maxChars: number): string {
  if (redact.enabled && secretPath(path) && !isUnset(read.value)) return HIDDEN;
  const value = redact.value(read.value);
  const text = valueText(value);
  const lines = [truncate(text, maxChars)];
  const cut: StatePath[] = [];
  findCut(value, path, cut);
  if (cut.length > 0) {
    const examples = cut.map((part) => JSON.stringify(formatPath(part))).join(' or ');
    lines.push(`This value is large, so the app cut some branches, shown as "[Object]" or "[Array(n)]". Read one with path, e.g. ${examples}.`);
  } else if (read.truncated) {
    lines.push('This value is large, so the app cut some of it. Read a part with path for the rest.');
  }
  if (text.length > maxChars) lines.push(`${partsHint(value, path)}, or pass a larger maxChars.`);
  return lines.join('\n');
}

function partsHint(value: SerializedValue, path: StatePath): string {
  const children = childrenOf(value);
  if (children.length === 0) return 'Read a part with path';
  // The app may have sent only the first items, so the range ends at the real length.
  const length = Array.isArray(value)
    ? value.length
    : isSpecial(value) && value.$t === 'array'
      ? value.length
      : isSpecial(value) && value.$t === 'set'
        ? value.size
        : 0;
  if (length > 0) return `Read items one at a time with path, from ${formatPath([...path, 0])} to ${formatPath([...path, length - 1])}`;
  const listed = children.slice(0, 12).map(([key, child]) => `${formatPath([...path, key])} (${preview(child, false, true)})`);
  if (children.length > listed.length) listed.push(`and ${children.length - listed.length} more`);
  return `Read a part with path: ${listed.join(', ')}`;
}

/** Paths of the branches the app cut short, so they can be read on their own. */
function findCut(value: SerializedValue, path: StatePath, found: StatePath[]): void {
  if (found.length >= 3) return;
  if (isSpecial(value) && value.$t === 'limit') {
    if (path.length > 0) found.push(path);
    return;
  }
  for (const [key, child] of childrenOf(value)) findCut(child, [...path, key], found);
}

/** Keys and values one level down, keyed the way the app's `readPath` follows them. */
function childrenOf(value: SerializedValue): Array<[string | number, SerializedValue]> {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.map((item, index) => [index, item]);
  if (!isSpecial(value)) return Object.entries(value as Record<string, SerializedValue>);
  switch (value.$t) {
    case 'object':
      return Object.entries(value.props);
    case 'error':
      return Object.entries(value.props ?? {});
    case 'array':
      return value.items.map((item, index) => [index, item]);
    case 'set':
      return value.values.map((item, index) => [index, item]);
    case 'map':
      return value.entries.flatMap(([key, item]): Array<[string | number, SerializedValue]> =>
        typeof key === 'string' || typeof key === 'number' ? [[key, item]] : [],
      );
    default:
      return [];
  }
}

export interface ChangeQuery {
  search?: string;
  after?: number;
  before?: number;
}

export function filterChanges(changes: ChangeEntry[], query: ChangeQuery): ChangeEntry[] {
  const matcher = searchMatcher(query.search);
  return changes.filter((entry) => {
    if (query.after !== undefined && entry.seq <= query.after) return false;
    if (query.before !== undefined && entry.seq >= query.before) return false;
    // What the UI's timeline filter matches: the action, then each changed path.
    return !matcher || matcher.test([stateChangeLabel(entry).text, ...entry.ops.map((op) => formatPath(op.path))].join('\n'));
  });
}

/** Ops shown under each change in a list; `seq` reads them all. */
const LISTED_OPS = 3;

/** A change in a list: markers for what was skipped or missed before it, its line, then its first ops. */
export function changeLines(entry: ChangeEntry, info: StateStoreInfo, redact: Redactor, tagged: boolean): string[] {
  const lines: string[] = [];
  if (entry.missed > 0) lines.push(`(${count(entry.missed, 'change')} missed)`);
  if (entry.skipped > 0) lines.push(`(${count(entry.skipped, info.actions ? 'action' : 'change')} skipped · folded into the next one)`);
  let head = `#${entry.seq} ${clock(entry.ts)} ${tagged ? `${info.label} · ` : ''}${changeName(entry, info)}`;
  if (entry.action) {
    const fields = actionFields(entry.action, redact);
    if (Object.keys(fields).length > 0) head += ` ${truncate(JSON.stringify(plainValue(fields)), 300)}`;
  }
  lines.push(head);
  const shown = entry.ops.slice(0, LISTED_OPS);
  lines.push(...shown.map((op) => `    ${opLine(op, redact)}`));
  if (entry.opCount > shown.length) lines.push(`    … ${entry.opCount - shown.length} more; pass seq: ${entry.seq} to read them`);
  return lines;
}

/** One change in full: its action as dispatched and every op the app sent. */
export function changeDetail(entry: ChangeEntry, info: StateStoreInfo, redact: Redactor): string {
  const noun = info.actions ? 'action' : 'change';
  const lines = [`#${entry.seq} ${clock(entry.ts)} ${changeName(entry, info)} · rev ${entry.rev}`];
  if (entry.missed > 0) lines.push(`${count(entry.missed, 'change')} before this one never arrived, e.g. while the server restarted.`);
  if (entry.skipped > 0) {
    const were = entry.skipped === 1 ? 'was' : 'were';
    lines.push(`${count(entry.skipped, noun)} before this one ${were} folded into it: too many at once, or the app was offline.`);
  }
  if (entry.action) {
    lines.push('Action:', indent(valueText({ type: entry.action.type, ...actionFields(entry.action, redact) }), '    '));
  } else if (info.actions && entry.cause !== 'init') {
    lines.push('No action: the app set the state directly.');
  }
  if (entry.ops.length === 0) {
    lines.push(entry.cause === 'init' ? 'The state the store started with; get_state shows what it holds now.' : 'Nothing changed.');
    return lines.join('\n');
  }
  lines.push(`${count(entry.opCount, 'change')} (+ added, ~ changed, − removed):`, ...entry.ops.map((op) => `    ${opLine(op, redact)}`));
  const cut = entry.opCount - entry.ops.length;
  if (cut > 0) lines.push(`${cut} more ${cut === 1 ? 'change was' : 'changes were'} left out; get_state shows the whole state as it is now.`);
  lines.push('Values are short previews; get_state reads the current value at a path.');
  return lines.join('\n');
}

function changeName(entry: ChangeEntry, info: StateStoreInfo): string {
  const label = stateChangeLabel(entry).text;
  // Only where changes come from dispatches does one from elsewhere stand out.
  if (!info.actions || entry.cause !== 'external') return label;
  return `${label} [${/^@@redux\/REPLACE/.test(label) ? 'hot reload' : 'changed outside a dispatch'}]`;
}

// `payload` holds the rest of the action, so its fields spread back to the top as dispatched: `{type, payload, meta}`.
function actionFields(action: NonNullable<ChangeEntry['action']>, redact: Redactor): Record<string, SerializedValue> {
  const rest = action.payload;
  const spread: Record<string, SerializedValue> =
    rest === undefined
      ? {}
      : typeof rest === 'object' && rest !== null && !Array.isArray(rest) && !isSpecial(rest)
        ? (rest as Record<string, SerializedValue>)
        : { payload: rest };
  // Redux Toolkit action creators called without an argument send `payload: undefined`, which says nothing.
  const fields = Object.fromEntries(
    Object.entries(spread).filter(([, value]) => !(isSpecial(value) && value.$t === 'undefined')),
  );
  if (!redact.enabled) return fields;
  // Hiding by key name misses a credential that is the whole payload, as in `setToken("eyJ…")`, so the type decides.
  if (SECRET_NAME.test(String(action.type))) {
    return Object.fromEntries(Object.entries(fields).map(([key, item]) => [key, isUnset(item) ? item : HIDDEN]));
  }
  return redact.value(fields) as Record<string, SerializedValue>;
}

const OP_SYMBOLS: Record<StateDiffOp['op'], string> = { add: '+', set: '~', del: '−' };

/** One op the way the UI's diff shows it: `~ cart.total 12.5 → 27`, `+ items[2] = {…}`, `− user.token "abc"`. */
function opLine(op: StateDiffOp, redact: Redactor): string {
  const secret = redact.enabled && secretPath(op.path);
  const shown = (item: SerializedValue | undefined) =>
    item === undefined ? undefined : secret && !isUnset(item) ? HIDDEN : redact.value(item);
  const text = formatOp({ ...op, prev: shown(op.prev), value: shown(op.value) });
  const symbol = OP_SYMBOLS[op.op] ?? '~';
  if (op.op === 'add') return `${symbol} ${text.path} = ${text.value ?? 'undefined'}`;
  if (op.op === 'del') return `${symbol} ${text.path} ${text.prev ?? 'undefined'}`;
  return `${symbol} ${text.path} ${text.prev ?? 'undefined'} → ${text.value ?? 'undefined'}`;
}

export type EntryStatus = 'error' | 'pending' | 'success' | 'fetching' | 'stale';

export interface EntryQuery {
  status?: EntryStatus;
  search?: string;
}

/** Matching entries, queries before mutations as the UI lists them. */
export function filterEntries(entries: StateEntrySummary[], query: EntryQuery): StateEntrySummary[] {
  const matcher = searchMatcher(query.search);
  const matched = entries.filter((entry) => {
    if (query.status && !hasStatus(entry, query.status)) return false;
    return !matcher || matcher.test(`${entry.label}\n${entry.key}`);
  });
  return [...matched.filter((entry) => entry.kind !== 'mutation'), ...matched.filter((entry) => entry.kind === 'mutation')];
}

function hasStatus(entry: StateEntrySummary, status: EntryStatus): boolean {
  switch (status) {
    case 'fetching':
      return entry.fetching;
    case 'stale':
      // TanStack marks every failed fetch invalidated, so freshness only means something for data that loaded.
      return entry.kind !== 'mutation' && entry.status === 'success' && Boolean(entry.stale || entry.invalidated);
    default:
      return entry.status === status;
  }
}

const KIND_LABELS: Record<StateEntrySummary['kind'], string> = {
  query: 'query',
  infinite: 'infinite query',
  mutation: 'mutation',
  swr: 'SWR key',
  'swr-infinite': 'SWR infinite key',
  'swr-subscription': 'SWR subscription',
};

/** `["todos"]: query, success, stale · 2 observers · updated 10:02:11.384 · data Array(20)`. */
export function entryLine(entry: StateEntrySummary, redact: Redactor): string {
  const query = entry.kind !== 'mutation';
  const loaded = query && entry.status === 'success';
  const words = [
    KIND_LABELS[entry.kind] ?? entry.kind,
    entry.status,
    entry.fetching ? 'fetching' : entry.paused ? 'paused' : undefined,
    loaded && entry.invalidated ? 'invalidated' : loaded && entry.stale ? 'stale' : undefined,
    query && entry.active === false ? 'inactive' : undefined,
    entry.disabled ? 'disabled' : undefined,
  ];
  const facts = [
    entry.observers === undefined ? undefined : count(entry.observers, 'observer'),
    entry.updatedAt ? `updated ${clock(entry.updatedAt)}` : undefined,
    entry.preview ? `data ${entry.preview}` : undefined,
    entry.error ? `error: ${truncate(redact.tokens(entry.error), 300)}` : undefined,
  ];
  // SWR keys can hold the token passed to the fetcher, as in `useSWR(['/api/user', token])`.
  const key = redact.tokens(entry.key);
  const label = redact.tokens(entry.label);
  const name = label && label !== key ? `${key} (${label})` : key;
  return [`${name}: ${words.filter(Boolean).join(', ')}`, ...facts.filter(Boolean)].join(' · ');
}

/** One entry with its data, credentials hidden; an entry keyed like a credential hides all of it, as storage does. */
export function entryDetail(result: NonNullable<StateCommands['entry']['result']>, path: StatePath, redact: Redactor, maxChars: number): string {
  const { summary } = result;
  const secret = redact.enabled && (SECRET_NAME.test(summary.key) || SECRET_NAME.test(summary.label));
  const lines = [entryLine(summary, redact)];
  if (summary.error && summary.error.length > 300) lines.push(`Error: ${summary.error}`);
  lines.push(path.length > 0 ? `Data at ${formatPath(path)}:` : 'Data:');
  lines.push(
    secret && !isUnset(result.data) ? HIDDEN : readValueText({ value: result.data, truncated: result.truncated }, path, redact, maxChars),
  );
  return lines.join('\n');
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

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (${(text.length - max).toLocaleString('en-US')} more characters)` : text;
}

function indent(text: string, prefix: string): string {
  return text.replace(/^/gm, prefix);
}
