import type {
  BodyPreview,
  CommandResult,
  CapybaraEvent,
  LogLevel,
  LogSource,
  NetworkErrorPayload,
  NetworkInitiator,
  SerializedValue,
  ServerInfo,
  ServerToViewer,
  SessionMeta,
} from '@capybara-devtools/protocol';
import { useSyncExternalStore } from 'react';
import { send, type ConnectionStatus } from './connection';

export interface LogEntry {
  seq: number;
  ts: number;
  level: LogLevel;
  source: LogSource;
  args: SerializedValue[];
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

export interface SessionState {
  meta: SessionMeta;
  /** History has arrived; until then live events for the session are ignored. */
  loaded: boolean;
  lastSeq: number;
  logs: LogEntry[];
  network: NetworkEntry[];
  /** Bumped per storage adapter whenever the app reports a write. */
  storageVersions: Record<string, number>;
}

export interface State {
  status: ConnectionStatus;
  server?: ServerInfo;
  sessions: Record<string, SessionState>;
  selectedId?: string;
}

const MAX_LOGS = 10_000;
const MAX_REQUESTS = 5_000;
const MAX_SOCKET_MESSAGES = 2_000;

let state: State = { status: 'connecting', sessions: {} };
const listeners = new Set<() => void>();
let notifyTimer: number | undefined;

function setState(next: State): void {
  state = next;
  if (notifyTimer !== undefined) return;
  // One render per ~frame however many messages arrive. setTimeout rather than
  // requestAnimationFrame so a hidden tab still catches up.
  notifyTimer = window.setTimeout(() => {
    notifyTimer = undefined;
    for (const listener of listeners) listener();
  }, 16);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `selector` must return something already in the state (not a new object), or React re-renders forever. */
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

// ---------------------------------------------------------------------------
// Server messages
// ---------------------------------------------------------------------------

export function setStatus(status: ConnectionStatus): void {
  setState({ ...state, status });
}

export function receive(message: Exclude<ServerToViewer, CommandResult>): void {
  switch (message.t) {
    case 'init': {
      const sessions: Record<string, SessionState> = {};
      for (const meta of message.sessions) sessions[meta.info.id] = emptySession(meta);
      const keep = state.selectedId && sessions[state.selectedId] ? state.selectedId : undefined;
      const selectedId = keep ?? pickDefault(sessions);
      setState({ ...state, server: message.server, sessions, selectedId });
      if (selectedId) send({ t: 'history', sessionId: selectedId });
      break;
    }
    case 'session': {
      const id = message.session.info.id;
      const existing = state.sessions[id];
      const sessions = {
        ...state.sessions,
        [id]: existing ? { ...existing, meta: message.session } : emptySession(message.session),
      };
      const current = state.selectedId ? sessions[state.selectedId] : undefined;
      let selectedId = state.selectedId;
      // A reloaded app shows up as a new session; follow it when the one on screen went offline.
      if (
        !current ||
        (id !== state.selectedId && message.session.connected && !current.meta.connected && sameApp(current.meta, message.session))
      ) {
        selectedId = id;
      }
      setState({ ...state, sessions, selectedId });
      if (selectedId === id && !sessions[id]!.loaded) send({ t: 'history', sessionId: id });
      break;
    }
    case 'session.removed': {
      const { [message.sessionId]: _removed, ...sessions } = state.sessions;
      const selectedId = state.selectedId === message.sessionId ? pickDefault(sessions) : state.selectedId;
      setState({ ...state, sessions, selectedId });
      if (selectedId && selectedId !== state.selectedId && !sessions[selectedId]!.loaded) {
        send({ t: 'history', sessionId: selectedId });
      }
      break;
    }
    case 'history': {
      const session = state.sessions[message.sessionId];
      if (!session) break;
      const reset: SessionState = { ...session, loaded: true, lastSeq: 0, logs: [], network: [] };
      updateSession(applyEvents(reset, message.events));
      break;
    }
    case 'events': {
      const session = state.sessions[message.sessionId];
      if (session?.loaded) updateSession(applyEvents(session, message.events));
      break;
    }
    case 'cleared': {
      const session = state.sessions[message.sessionId];
      // lastSeq is kept: the app keeps counting, so later events still apply. Live sockets stay,
      // without their messages, so the ones that arrive next still have a row to land in.
      const live = (entry: NetworkEntry) => entry.socket && (entry.state === 'open' || entry.state === 'pending');
      if (session) {
        const network = session.network
          .filter(live)
          .map((entry) => ({ ...entry, socket: { ...entry.socket!, messages: [], dropped: 0, sent: 0, received: 0, bytes: 0 } }));
        updateSession({ ...session, logs: [], network });
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// User actions
// ---------------------------------------------------------------------------

export function selectSession(id: string): void {
  const session = state.sessions[id];
  if (!session) return;
  setState({ ...state, selectedId: id });
  if (!session.loaded) send({ t: 'history', sessionId: id });
}

export function clearSession(id: string): void {
  send({ t: 'clear', sessionId: id });
}

export function removeSession(id: string): void {
  send({ t: 'remove', sessionId: id });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptySession(meta: SessionMeta): SessionState {
  return { meta, loaded: false, lastSeq: 0, logs: [], network: [], storageVersions: {} };
}

function updateSession(session: SessionState): void {
  setState({ ...state, sessions: { ...state.sessions, [session.meta.info.id]: session } });
}

function pickDefault(sessions: Record<string, SessionState>): string | undefined {
  const sorted = Object.values(sessions).sort(
    (a, b) => Number(b.meta.connected) - Number(a.meta.connected) || b.meta.info.startedAt - a.meta.info.startedAt,
  );
  return sorted[0]?.meta.info.id;
}

function sameApp(a: SessionMeta, b: SessionMeta): boolean {
  return (
    a.info.appName === b.info.appName &&
    a.info.platform === b.info.platform &&
    a.info.device?.model === b.info.device?.model &&
    a.info.userAgent === b.info.userAgent
  );
}

function applyEvents(session: SessionState, events: CapybaraEvent[]): SessionState {
  let { logs, network, storageVersions, lastSeq } = session;
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
        list[index] = {
          ...list[index]!,
          state: 'done',
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
        if (socket.messages.length > MAX_SOCKET_MESSAGES) {
          const extra = socket.messages.length - MAX_SOCKET_MESSAGES;
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
    }
  }

  if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
  if (network.length > MAX_REQUESTS) network = network.slice(-MAX_REQUESTS);
  return { ...session, logs, network, storageVersions, lastSeq };
}

/** Responses usually belong to recent requests, so search from the end. */
function findRequest(network: NetworkEntry[], id: string): number {
  for (let i = network.length - 1; i >= 0; i--) if (network[i]!.id === id) return i;
  return -1;
}
