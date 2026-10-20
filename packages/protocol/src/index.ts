import type { LatestVersions } from './versions.js';

/** Bump on breaking changes to any message shape below; the server rejects mismatched clients. */
export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 7357;
export const CLIENT_PATH = '/client';
export const VIEWER_PATH = '/viewer';
/** `sdk.name` of sessions the server reads from Metro, for React Native apps without the SDK. */
export const METRO_SDK = 'metro';

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export type Platform = 'web' | 'ios' | 'android' | 'windows' | 'macos' | 'unknown';

export interface DeviceInfo {
  model?: string;
  osVersion?: string;
  isEmulator?: boolean;
}

/** One app launch or page load. */
export interface SessionInfo {
  id: string;
  appName: string;
  platform: Platform;
  sdk: { name: string; version: string };
  startedAt: number;
  device?: DeviceInfo;
  /** JS engine and framework version, e.g. "Hermes · RN 0.86.3". */
  runtime?: string;
  /** Page URL, web only. */
  url?: string;
  userAgent?: string;
  /** Names of the plugins the SDK runs, e.g. "network". Older SDKs and Metro sessions leave it out. */
  plugins?: string[];
}

// ---------------------------------------------------------------------------
// Serialized values
// ---------------------------------------------------------------------------

/**
 * JSON-safe representation of an arbitrary JS value. Values JSON cannot carry
 * are encoded as objects with a `$t` tag. Plain objects that happen to own a
 * `$t` key are wrapped in `{ $t: 'object' }` so the tag is never ambiguous.
 */
export type SerializedValue =
  | null
  | boolean
  | number
  | string
  | SerializedValue[]
  | SpecialValue
  | { [key: string]: SerializedValue };

export type SpecialValue =
  | { $t: 'undefined' }
  | { $t: 'number'; v: 'NaN' | 'Infinity' | '-Infinity' | '-0' }
  | { $t: 'bigint'; v: string }
  | { $t: 'symbol'; v: string }
  | { $t: 'function'; name: string }
  | { $t: 'date'; v: string }
  | { $t: 'regexp'; v: string }
  | { $t: 'error'; name: string; message: string; stack?: string; props?: Record<string, SerializedValue> }
  /** Truncated string; `length` is the original length. */
  | { $t: 'string'; v: string; length: number }
  /** Truncated array; `length` is the original length. */
  | { $t: 'array'; items: SerializedValue[]; length: number }
  /** Class instance, truncated object, or object owning a `$t` key. `more` counts omitted keys. */
  | { $t: 'object'; name?: string; props: Record<string, SerializedValue>; more?: number }
  | { $t: 'map'; entries: [SerializedValue, SerializedValue][]; size: number }
  | { $t: 'set'; values: SerializedValue[]; size: number }
  | { $t: 'binary'; name: string; size: number }
  | { $t: 'node'; v: string }
  | { $t: 'circular' }
  /** Depth or size budget exhausted; `name` describes what was cut, e.g. "Array(12)". */
  | { $t: 'limit'; name: string };

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'log' | 'info' | 'warn' | 'error';
export type LogSource = 'console' | 'uncaught' | 'unhandledrejection' | 'api';

export interface LogPayload {
  level: LogLevel;
  source: LogSource;
  args: SerializedValue[];
}

/** Through Metro, `other` is a request reported without the JS stack that tells fetch from XHR, as Expo Go reports them. */
export type NetworkInitiator = 'fetch' | 'xhr' | 'image' | 'other';

export interface BodyPreview {
  /** Only `text` and `form` bodies carry `text`; the rest are described by `summary`. */
  kind: 'text' | 'form' | 'binary' | 'stream' | 'unknown';
  text?: string;
  /** Size in bytes, when known. */
  size?: number;
  truncated?: boolean;
  contentType?: string;
  summary?: string;
}

export interface NetworkRequestPayload {
  id: string;
  initiator: NetworkInitiator;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: BodyPreview;
}

export interface NetworkResponsePayload {
  id: string;
  status: number;
  statusText?: string;
  headers: Record<string, string>;
  body?: BodyPreview;
  /** Milliseconds from request start to response headers. */
  duration: number;
}

/**
 * Why a request failed, as far as the app can tell. Browsers never tell a page why a request
 * failed, so `cross-origin` only says the cause is unknown there: usually CORS, otherwise the
 * server being unreachable. The Capybara server can find out with a `diagnose` request.
 */
export type NetworkFailureCause = 'offline' | 'mixed-content' | 'csp' | 'cross-origin';

export interface NetworkErrorPayload {
  id: string;
  message: string;
  duration: number;
  aborted?: boolean;
  timeout?: boolean;
  cause?: NetworkFailureCause;
  /** Cookies were sent cross-origin, which CORS allows only with Access-Control-Allow-Credentials. */
  credentials?: boolean;
}

/** A WebSocket the app created. Later `ws.*` events refer to it by `id`. */
export interface WebSocketConnectPayload {
  id: string;
  url: string;
  protocols?: string[];
  /** First seen after it was created, so earlier traffic was not captured. */
  existing?: boolean;
}

export interface WebSocketOpenPayload {
  id: string;
  /** Subprotocol the server selected. */
  protocol?: string;
  extensions?: string;
  /** Milliseconds from creation (or first sight) to the handshake. */
  duration: number;
}

export interface WebSocketMessagePayload {
  id: string;
  direction: 'sent' | 'received';
  /** Text frames carry `text`; binary frames only their size. */
  data: BodyPreview;
}

export interface WebSocketErrorPayload {
  id: string;
  message: string;
}

export interface WebSocketClosePayload {
  id: string;
  code?: number;
  reason?: string;
  wasClean?: boolean;
  /** Milliseconds from creation (or first sight) to the close. */
  duration: number;
}

export type StorageOp = 'set' | 'remove' | 'clear' | 'merge' | 'unknown';

export interface StorageChangePayload {
  adapter: string;
  op: StorageOp;
  key?: string;
}

export type StateLibrary = 'redux' | 'zustand' | 'tanstack-query' | 'swr' | 'context';

/** Keys from the root of a store's state or an entry's data, e.g. `['todos', 0, 'title']`. */
export type StatePath = Array<string | number>;

/** Commands on one cache entry; each store lists the ones it supports in `ops`. */
export type StateEntryOp = 'refetch' | 'invalidate' | 'reset' | 'cancel' | 'remove' | 'revalidate' | 'clear';

/** A store the app registered. Sent again under the same `id` whenever this changes, e.g. once it is disposed. */
export interface StateStoreInfo {
  /** Stable for the session, e.g. "redux:1". */
  id: string;
  library: StateLibrary;
  label: string;
  /** How the SDK found the store. */
  via: 'shim' | 'enhancer' | 'connect' | 'subscribe' | 'client' | 'cache' | 'fiber' | 'module';
  /** False when changes come with a diff but no action name. */
  actions: boolean;
  /** Commands its entries support. Only stores with entries (TanStack Query, SWR) have any. */
  ops?: StateEntryOp[];
  /** React Context: the library the context belongs to, e.g. "react-redux", rather than the app. */
  vendor?: string;
  /** React Context: providers of the context mounted under this label, when there is more than one. */
  instances?: number;
  disposed?: boolean;
  note?: string;
}

/** `value` and `prev` are short previews; the `get` command reads the full value. */
export interface StateDiffOp {
  op: 'set' | 'add' | 'del';
  path: StatePath;
  value?: SerializedValue;
  prev?: SerializedValue;
}

export interface StateChangePayload {
  store: string;
  /** Counts up by one per `state.change` of the store, so a gap means some were missed. */
  rev: number;
  cause: 'init' | 'action' | 'set' | 'external';
  /** `payload` previews the rest of the action without `type`, e.g. `{payload, meta}` for Redux Toolkit. */
  action?: { type: string; payload?: SerializedValue };
  ops: StateDiffOp[];
  /** Number of ops before `ops` was cut, when it was. */
  opCount?: number;
  /** Changes folded into this one, by the rate limit or while the app was not connected. */
  skipped?: number;
}

/** A TanStack Query or SWR cache entry, without its data. */
export interface StateEntrySummary {
  /** Names the entry in the `entry` and `act` commands, e.g. a query hash. */
  key: string;
  label: string;
  kind: 'query' | 'infinite' | 'mutation' | 'swr' | 'swr-infinite' | 'swr-subscription';
  status: 'pending' | 'success' | 'error' | 'idle';
  fetching: boolean;
  paused?: boolean;
  stale?: boolean;
  invalidated?: boolean;
  active?: boolean;
  disabled?: boolean;
  observers?: number;
  updatedAt?: number;
  error?: string;
  /** Short description of the data, e.g. "Array(20)". */
  preview?: string;
}

export interface StateEntriesPayload {
  store: string;
  upserts: StateEntrySummary[];
  removed: string[];
  /** Forget every entry seen before. `upserts` may then hold only some; the `entries` command lists them all. */
  reset?: boolean;
}

export interface EventPayloads {
  log: LogPayload;
  'network.request': NetworkRequestPayload;
  'network.response': NetworkResponsePayload;
  'network.error': NetworkErrorPayload;
  'ws.connect': WebSocketConnectPayload;
  'ws.open': WebSocketOpenPayload;
  'ws.message': WebSocketMessagePayload;
  'ws.error': WebSocketErrorPayload;
  'ws.close': WebSocketClosePayload;
  'storage.change': StorageChangePayload;
  /** The server keeps the latest one of each store in the history, through `clear` too. */
  'state.store': { store: StateStoreInfo };
  'state.change': StateChangePayload;
  'state.entries': StateEntriesPayload;
}

export type EventKind = keyof EventPayloads;

export type CapybaraEvent = {
  [K in EventKind]: { seq: number; ts: number; kind: K; payload: EventPayloads[K] };
}[EventKind];

export type EventOf<K extends EventKind> = Extract<CapybaraEvent, { kind: K }>;

// ---------------------------------------------------------------------------
// Storage commands
// ---------------------------------------------------------------------------

export interface StorageAdapterInfo {
  id: string;
  label: string;
  readOnly: boolean;
  canClear: boolean;
  note?: string;
}

export interface StorageEntry {
  key: string;
  value: string | null;
  /** Size of the full value in bytes. */
  size: number;
  truncated: boolean;
}

export interface StorageEntries {
  entries: StorageEntry[];
  /** Total number of keys; `entries` may be capped. */
  total: number;
}

/** `plugin: 'storage'` commands, keyed by method. */
export interface StorageCommands {
  list: { params: undefined; result: StorageAdapterInfo[] };
  entries: { params: { adapter: string }; result: StorageEntries };
  get: { params: { adapter: string; key: string }; result: StorageEntry | null };
  set: { params: { adapter: string; key: string; value: string }; result: null };
  remove: { params: { adapter: string; key: string }; result: null };
  clear: { params: { adapter: string }; result: null };
}

// ---------------------------------------------------------------------------
// State commands
// ---------------------------------------------------------------------------

/**
 * `plugin: 'state'` commands, keyed by method. Events only say what changed; current values are read here,
 * by path. A `truncated` value was cut to fit: read a deeper `path` for the rest.
 */
export interface StateCommands {
  stores: { params: undefined; result: StateStoreInfo[] };
  /** `rev` is the latest recorded change; `pending` means the store has changed since. */
  get: {
    params: { store: string; path?: StatePath };
    result: { rev: number; pending: boolean; value: SerializedValue; truncated: boolean };
  };
  /** `total` counts every entry; `entries` may be capped. */
  entries: { params: { store: string }; result: { entries: StateEntrySummary[]; total: number } };
  entry: {
    params: { store: string; key: string; path?: StatePath };
    result: { summary: StateEntrySummary; data: SerializedValue; truncated: boolean } | null;
  };
  /** `done: false` comes with a `note` saying why, e.g. no mounted hook to revalidate. */
  act: { params: { store: string; key: string; op: StateEntryOp }; result: { done: boolean; note?: string } };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type CommandResult =
  | { t: 'result'; id: string; ok: true; result?: unknown }
  | { t: 'result'; id: string; ok: false; error: string };

export type ClientToServer =
  | { t: 'hello'; protocol: number; session: SessionInfo }
  | { t: 'events'; events: CapybaraEvent[] }
  | CommandResult;

export type ServerToClient =
  /** `lastSeq` is the newest event the server already has for this session. */
  | { t: 'welcome'; lastSeq: number }
  | { t: 'command'; id: string; plugin: string; method: string; params?: unknown }
  | { t: 'reject'; reason: string };

export interface SessionMeta {
  info: SessionInfo;
  connected: boolean;
  lastSeen: number;
  eventCount: number;
}

export interface ServerInfo {
  version: string;
  port: number;
  /** Where phones on the network reach the server: its non-internal IPv4 addresses, none when it listens on loopback. */
  addresses: string[];
  /** Other devices may open the UI at those addresses (`--remote-ui`). Missing from older servers. */
  remoteUi?: boolean;
  /** Newest versions on npm, once the server has looked them up. Missing when the check is off or failed. */
  latest?: LatestVersions;
  /**
   * What the person at this computer should know, oldest first: a device was refused the UI, an app cannot be read
   * through Metro. The CLI also prints them; the desktop app has nowhere else to show them. Missing from older servers.
   */
  hints?: string[];
}

/** One step of a diagnosis: a browser rule that passed or failed, or something the server saw on the way. */
export interface DiagnosisCheck {
  label: string;
  outcome: 'pass' | 'fail' | 'info';
  detail: string;
}

/** The result of a `diagnose` request: the server repeats the request's CORS steps from the dev machine. */
export interface NetworkDiagnosis {
  verdict: 'cors' | 'unreachable' | 'ok' | 'unknown';
  summary: string;
  checks: DiagnosisCheck[];
  /** Requests the server sent, e.g. "OPTIONS https://api.example.com/me". */
  sent: string[];
}

export type ViewerToServer =
  /** `parts` asks for the history in parts; servers before 0.5.1 send it in one message whatever its size. */
  | { t: 'history'; sessionId: string; parts?: true }
  | { t: 'command'; id: string; sessionId: string; plugin: string; method: string; params?: unknown }
  /** Answered with a CommandResult whose `result` is a NetworkDiagnosis. */
  | { t: 'diagnose'; id: string; sessionId: string; requestId: string }
  /** `scope: 'state'` clears only the state timeline; servers before 0.3.0 ignore it and clear everything. */
  | { t: 'clear'; sessionId: string; scope?: 'state' }
  | { t: 'remove'; sessionId: string };

export type ServerToViewer =
  | { t: 'init'; server: ServerInfo; sessions: SessionMeta[] }
  /** Sent when the server info changes after `init`, e.g. once the npm lookup is done. */
  | { t: 'server'; server: ServerInfo }
  | { t: 'session'; session: SessionMeta }
  | { t: 'session.removed'; sessionId: string }
  /** Every part but the last has `more`. */
  | { t: 'history'; sessionId: string; events: CapybaraEvent[]; more?: true }
  | { t: 'events'; sessionId: string; events: CapybaraEvent[] }
  | { t: 'cleared'; sessionId: string; scope?: 'state' }
  | CommandResult;

export * from './limits.js';
export * from './values.js';
export * from './versions.js';
