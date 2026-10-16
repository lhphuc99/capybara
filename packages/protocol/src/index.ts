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

/** Metro reports fetch and XHR alike, so its requests are `other` (or `image`). */
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

export interface NetworkErrorPayload {
  id: string;
  message: string;
  duration: number;
  aborted?: boolean;
  timeout?: boolean;
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
}

export type EventKind = keyof EventPayloads;

export type DevsightEvent = {
  [K in EventKind]: { seq: number; ts: number; kind: K; payload: EventPayloads[K] };
}[EventKind];

export type EventOf<K extends EventKind> = Extract<DevsightEvent, { kind: K }>;

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
// Messages
// ---------------------------------------------------------------------------

export type CommandResult =
  | { t: 'result'; id: string; ok: true; result?: unknown }
  | { t: 'result'; id: string; ok: false; error: string };

export type ClientToServer =
  | { t: 'hello'; protocol: number; session: SessionInfo }
  | { t: 'events'; events: DevsightEvent[] }
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
  /** Non-internal IPv4 addresses of the machine running the server. */
  addresses: string[];
}

export type ViewerToServer =
  | { t: 'history'; sessionId: string }
  | { t: 'command'; id: string; sessionId: string; plugin: string; method: string; params?: unknown }
  | { t: 'clear'; sessionId: string }
  | { t: 'remove'; sessionId: string };

export type ServerToViewer =
  | { t: 'init'; server: ServerInfo; sessions: SessionMeta[] }
  | { t: 'session'; session: SessionMeta }
  | { t: 'session.removed'; sessionId: string }
  | { t: 'history'; sessionId: string; events: DevsightEvent[] }
  | { t: 'events'; sessionId: string; events: DevsightEvent[] }
  | { t: 'cleared'; sessionId: string }
  | CommandResult;
