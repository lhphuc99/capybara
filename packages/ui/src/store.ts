import {
  applySessionEvents,
  applyStateEvent,
  clearStateRecords,
  emptySessionModel,
  emptyStateSlice,
  type CommandResult,
  type NetworkEntry,
  type ServerInfo,
  type ServerToViewer,
  type SessionMeta,
  type SessionModel,
  type StateEntrySummary,
  type StateEvent,
  type StateStoreInfo,
} from '@capybara-devtools/protocol';
import { useSyncExternalStore } from 'react';
import { send, type ConnectionStatus } from './connection';
import { showToast } from './toast';

export type { LogEntry, NetworkEntry, SocketInfo, SocketMessage } from '@capybara-devtools/protocol';

export interface SessionState extends SessionModel {
  meta: SessionMeta;
  /** History has arrived; until then live events for the session are ignored. */
  loaded: boolean;
}

export interface State {
  status: ConnectionStatus;
  server?: ServerInfo;
  sessions: Record<string, SessionState>;
  selectedId?: string;
}

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
      historyParts.clear();
      setState({ ...state, server: message.server, sessions, selectedId });
      if (selectedId) requestHistory(selectedId);
      break;
    }
    case 'server':
      setState({ ...state, server: message.server });
      break;
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
      if (selectedId === id && !sessions[id]!.loaded) requestHistory(id);
      break;
    }
    case 'session.removed': {
      const { [message.sessionId]: _removed, ...sessions } = state.sessions;
      const selectedId = state.selectedId === message.sessionId ? pickDefault(sessions) : state.selectedId;
      setState({ ...state, sessions, selectedId });
      if (selectedId && selectedId !== state.selectedId && !sessions[selectedId]!.loaded) requestHistory(selectedId);
      break;
    }
    case 'history': {
      const session = state.sessions[message.sessionId];
      if (!session) break;
      // The first part starts over; the session shows once the last is in.
      const base: SessionState = historyParts.has(message.sessionId)
        ? session
        : { ...session, lastSeq: 0, logs: [], network: [], state: emptyStateSlice() };
      if (message.more) historyParts.add(message.sessionId);
      else historyParts.delete(message.sessionId);
      updateSession(applySessionEvents({ ...base, loaded: !message.more }, message.events));
      break;
    }
    case 'events': {
      const session = state.sessions[message.sessionId];
      if (session?.loaded) updateSession(applySessionEvents(session, message.events));
      break;
    }
    case 'cleared': {
      const session = state.sessions[message.sessionId];
      // lastSeq is kept: the app keeps counting, so later events still apply. Live sockets stay,
      // without their messages, so the ones that arrive next still have a row to land in.
      const live = (entry: NetworkEntry) => entry.socket && (entry.state === 'open' || entry.state === 'pending');
      if (session && message.scope === 'state') {
        updateSession({ ...session, state: clearStateRecords(session.state) });
      } else if (session) {
        const network = session.network
          .filter(live)
          .map((entry) => ({ ...entry, socket: { ...entry.socket!, messages: [], dropped: 0, sent: 0, received: 0, bytes: 0 } }));
        updateSession({ ...session, logs: [], network, state: clearStateRecords(session.state) });
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
  if (!session.loaded) requestHistory(id);
}

/** Sessions whose history came in part and has more to come. */
const historyParts = new Set<string>();

/** In parts: in one message, a busy session's history can be more than a string can hold. */
function requestHistory(id: string): void {
  send({ t: 'history', sessionId: id, parts: true });
}

export function clearSession(id: string): void {
  sendAction({ t: 'clear', sessionId: id });
}

/** Clears the recorded state changes and leaves logs and requests alone. */
export function clearStateTimeline(id: string): void {
  sendAction({ t: 'clear', sessionId: id, scope: 'state' });
}

export function removeSession(id: string): void {
  sendAction({ t: 'remove', sessionId: id });
}

/** The server does these, so while it is unreachable the button would seem to do nothing. */
function sendAction(message: Parameters<typeof send>[0]): void {
  if (!send(message)) showToast('The Capybara server is offline. Try again once it reconnects.', 'error');
}

/** Adds or updates stores the `stores` command found, e.g. ones the server lost when it restarted. */
export function mergeStateStores(sessionId: string, stores: StateStoreInfo[]): void {
  const session = state.sessions[sessionId];
  if (!session) return;
  const owned = new WeakSet<object>();
  let slice = session.state;
  for (const store of stores) {
    slice = applyStateEvent(slice, { seq: 0, ts: Date.now(), kind: 'state.store', payload: { store } }, owned);
  }
  updateSession({ ...session, state: slice });
}

/** Replaces a store's entries with the list the `entries` command read; `clear` and trimming drop the patches. */
export function loadStateEntries(sessionId: string, store: string, entries: StateEntrySummary[]): void {
  const session = state.sessions[sessionId];
  if (!session) return;
  const event: StateEvent = {
    seq: 0,
    ts: Date.now(),
    kind: 'state.entries',
    payload: { store, upserts: entries, removed: [], reset: true },
  };
  updateSession({ ...session, state: applyStateEvent(session.state, event) });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptySession(meta: SessionMeta): SessionState {
  return { meta, loaded: false, ...emptySessionModel() };
}

function updateSession(session: SessionState): void {
  setState({ ...state, sessions: { ...state.sessions, [session.meta.info.id]: session } });
}

/** The newest app still connected, one on this computer first: any device on the network can connect as an app. */
function pickDefault(sessions: Record<string, SessionState>): string | undefined {
  const sorted = Object.values(sessions).sort(
    (a, b) =>
      Number(b.meta.connected) - Number(a.meta.connected) ||
      Number(!b.meta.address) - Number(!a.meta.address) ||
      b.meta.info.startedAt - a.meta.info.startedAt,
  );
  return sorted[0]?.meta.info.id;
}

function sameApp(a: SessionMeta, b: SessionMeta): boolean {
  return (
    a.info.appName === b.info.appName &&
    a.info.platform === b.info.platform &&
    a.info.device?.model === b.info.device?.model &&
    a.info.userAgent === b.info.userAgent &&
    a.address === b.address
  );
}

