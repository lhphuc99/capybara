import type { BodyPreview, CapybaraEvent, LogPayload, NetworkErrorPayload, NetworkInitiator } from './index.js';
import { applyStateEvent, emptyStateSlice, type StateLimits, type StateSlice } from './state-model.js';

// What a session's events add up to, as the UI shows it and `capybara mcp` reports it.

export interface LogEntry extends LogPayload {
  seq: number;
  ts: number;
}

export interface NetworkEntry {
  id: string;
  seq: number;
  ts: number;
  initiator: NetworkInitiator | 'websocket';
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody?: BodyPreview;
  /** `open` is only used by WebSockets. */
  state: 'pending' | 'open' | 'done' | 'failed';
  /** Still pending, with its response headers in and its body arriving. */
  streaming?: true;
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: BodyPreview;
  /** For WebSockets, how long the connection lasted. */
  duration?: number;
  error?: string;
  /** What the app could tell about why the request failed. */
  failure?: Pick<NetworkErrorPayload, 'cause' | 'credentials' | 'aborted' | 'timeout'>;
  socket?: SocketInfo;
}

export interface SocketMessage {
  seq: number;
  ts: number;
  direction: 'sent' | 'received';
  data: BodyPreview;
}

export interface SocketInfo {
  protocols?: string[];
  protocol?: string;
  extensions?: string;
  /** Already open when first seen, so earlier messages are missing. */
  existing?: boolean;
  handshake?: number;
  messages: SocketMessage[];
  /** Oldest messages dropped to bound memory. */
  dropped: number;
  sent: number;
  received: number;
  bytes: number;
  closeCode?: number;
  closeReason?: string;
  wasClean?: boolean;
}

export interface SessionModel {
  /** Events at or below it were applied already, and are skipped. */
  lastSeq: number;
  logs: LogEntry[];
  network: NetworkEntry[];
  /** Bumped per storage adapter whenever the app reports a write. */
  storageVersions: Record<string, number>;
  state: StateSlice;
}

/** How much is kept, oldest dropped first: the UI's defaults bound its memory. */
export interface SessionLimits extends StateLimits {
  logs?: number;
  requests?: number;
  socketMessages?: number;
}

export const MAX_LOGS = 10_000;
export const MAX_REQUESTS = 5_000;
export const MAX_SOCKET_MESSAGES = 2_000;

export function emptySessionModel(): SessionModel {
  return { lastSeq: 0, logs: [], network: [], storageVersions: {}, state: emptyStateSlice() };
}

/** Returns `model` with `events` applied; `model` itself is left as it was, and each list is copied once per call. */
export function applySessionEvents<T extends SessionModel>(model: T, events: CapybaraEvent[], limits: SessionLimits = {}): T {
  let { logs, network, storageVersions, lastSeq, state: stateSlice } = model;
  const maxSocketMessages = limits.socketMessages ?? MAX_SOCKET_MESSAGES;
  const stateOwned = new WeakSet<object>();
  let logsCopied = false;
  let networkCopied = false;
  let versionsCopied = false;
  const editableNetwork = () => {
    if (!networkCopied) {
      network = network.slice();
      networkCopied = true;
    }
    return network;
  };
  // Busy sockets send many messages per batch: look each one up once and copy its message list once.
  const located = new Map<string, number>();
  const locate = (id: string) => {
    const cached = located.get(id);
    if (cached !== undefined && network[cached]?.id === id) return cached;
    const index = findRequest(network, id);
    if (index >= 0) located.set(id, index);
    return index;
  };
  const ownedSockets = new Set<string>();
  const editableSocket = (index: number): NetworkEntry & { socket: SocketInfo } => {
    const list = editableNetwork();
    const entry = list[index]!;
    if (!ownedSockets.has(entry.id)) {
      list[index] = { ...entry, socket: { ...entry.socket!, messages: entry.socket!.messages.slice() } };
      ownedSockets.add(entry.id);
    }
    return list[index] as NetworkEntry & { socket: SocketInfo };
  };

  for (const event of events) {
    if (event.seq <= lastSeq) continue;
    lastSeq = event.seq;
    switch (event.kind) {
      case 'log':
        if (!logsCopied) {
          logs = logs.slice();
          logsCopied = true;
        }
        logs.push({ seq: event.seq, ts: event.ts, ...event.payload });
        break;
      case 'network.request': {
        const p = event.payload;
        editableNetwork().push({
          id: p.id,
          seq: event.seq,
          ts: event.ts,
          initiator: p.initiator,
          method: p.method,
          url: p.url,
          requestHeaders: p.headers,
          requestBody: p.body,
          state: 'pending',
        });
        break;
      }
      case 'network.response': {
        const p = event.payload;
        const index = findRequest(network, p.id);
        // The request may have been trimmed from the server's buffer; a lone response says little.
        if (index < 0) break;
        const list = editableNetwork();
        const { streaming: _, ...entry } = list[index]!;
        list[index] = {
          ...entry,
          state: p.streaming ? 'pending' : 'done',
          ...(p.streaming && { streaming: true }),
          status: p.status,
          statusText: p.statusText,
          responseHeaders: p.headers,
          responseBody: p.body,
          duration: p.duration,
        };
        break;
      }
      case 'network.error': {
        const p = event.payload;
        const index = findRequest(network, p.id);
        if (index < 0) break;
        const list = editableNetwork();
        list[index] = {
          ...list[index]!,
          state: 'failed',
          error: p.message,
          duration: p.duration,
          failure: { cause: p.cause, credentials: p.credentials, aborted: p.aborted, timeout: p.timeout },
        };
        break;
      }
      case 'ws.connect': {
        const p = event.payload;
        editableNetwork().push({
          id: p.id,
          seq: event.seq,
          ts: event.ts,
          initiator: 'websocket',
          method: 'WS',
          url: p.url,
          requestHeaders: {},
          state: 'pending',
          socket: { protocols: p.protocols, existing: p.existing, messages: [], dropped: 0, sent: 0, received: 0, bytes: 0 },
        });
        ownedSockets.add(p.id);
        break;
      }
      case 'ws.open': {
        const p = event.payload;
        const index = locate(p.id);
        if (index < 0 || !network[index]!.socket) break;
        const entry = editableSocket(index);
        entry.state = 'open';
        entry.status = 101;
        entry.statusText = 'Switching Protocols';
        entry.socket.protocol = p.protocol;
        entry.socket.extensions = p.extensions;
        entry.socket.handshake = p.duration;
        break;
      }
      case 'ws.message': {
        const p = event.payload;
        const index = locate(p.id);
        if (index < 0 || !network[index]!.socket) break;
        const { socket } = editableSocket(index);
        socket.messages.push({ seq: event.seq, ts: event.ts, direction: p.direction, data: p.data });
        if (p.direction === 'sent') socket.sent++;
        else socket.received++;
        socket.bytes += p.data.size ?? 0;
        if (socket.messages.length > maxSocketMessages) {
          const extra = socket.messages.length - maxSocketMessages;
          socket.messages.splice(0, extra);
          socket.dropped += extra;
        }
        break;
      }
      case 'ws.error': {
        const index = locate(event.payload.id);
        if (index < 0 || !network[index]!.socket) break;
        editableSocket(index).error = event.payload.message;
        break;
      }
      case 'ws.close': {
        const p = event.payload;
        const index = locate(p.id);
        if (index < 0 || !network[index]!.socket) break;
        const entry = editableSocket(index);
        // 1006 means the connection dropped without a close frame.
        entry.state = entry.state === 'open' && p.code !== 1006 && !entry.error ? 'done' : 'failed';
        entry.duration = p.duration;
        entry.socket.closeCode = p.code;
        entry.socket.closeReason = p.reason;
        entry.socket.wasClean = p.wasClean;
        if (entry.state === 'failed' && !entry.error) entry.error = p.reason || `Closed with code ${p.code ?? 'unknown'}`;
        break;
      }
      case 'storage.change':
        if (!versionsCopied) {
          storageVersions = { ...storageVersions };
          versionsCopied = true;
        }
        storageVersions[event.payload.adapter] = (storageVersions[event.payload.adapter] ?? 0) + 1;
        break;
      case 'state.store':
      case 'state.change':
      case 'state.entries':
        stateSlice = applyStateEvent(stateSlice, event, stateOwned, limits);
        break;
    }
  }

  const maxLogs = limits.logs ?? MAX_LOGS;
  const maxRequests = limits.requests ?? MAX_REQUESTS;
  if (logs.length > maxLogs) logs = logs.slice(-maxLogs);
  if (network.length > maxRequests) network = network.slice(-maxRequests);
  return { ...model, logs, network, storageVersions, lastSeq, state: stateSlice };
}

/** Responses usually belong to recent requests, so search from the end. */
function findRequest(network: NetworkEntry[], id: string): number {
  for (let i = network.length - 1; i >= 0; i--) if (network[i]!.id === id) return i;
  return -1;
}
