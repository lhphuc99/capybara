import http from 'node:http';
import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import {
  CLIENT_PATH,
  PROTOCOL_VERSION,
  VIEWER_PATH,
  type ClientToServer,
  type CommandResult,
  type CapybaraEvent,
  type EventOf,
  type LatestVersions,
  type ServerInfo,
  type ServerToClient,
  type ServerToViewer,
  type SessionInfo,
  type SessionMeta,
  type ViewerToServer,
} from '@capybara-devtools/protocol';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { diagnoseRequest } from './diagnose.js';
import { isAllowedHost, isAllowedViewerOrigin, isLocalConnection, isLoopbackAddress, unmapped } from './security.js';
import { refuseRemote, serveStatic } from './static.js';
import { hasBundleFrames, symbolicateEvents } from './symbolicate.js';

export { reverseAndroidPorts } from './adb.js';
export { DEFAULT_METRO_PORTS, startMetroBridge, type MetroBridge, type MetroBridgeOptions } from './metro.js';
export { fetchLatestVersions } from './updates.js';

export interface ServerOptions {
  /** 0 picks a free port. */
  port: number;
  /** Address to bind. Default: all interfaces, so phones on the same network can connect. */
  host?: string;
  /** Directory with the built UI. Without one a placeholder page is served. */
  uiDir?: string;
  /** Extra origins allowed to open the viewer socket, e.g. the Vite dev server for the UI. */
  allowedOrigins?: string[];
  /**
   * Let other devices open the UI and the viewer socket (`capybara mcp --host`), which show everything
   * apps send, tokens included. Default false: only this machine; apps connect from anywhere either way.
   */
  remoteUi?: boolean;
  /** Told once per device that was refused the UI, with how to let it in. */
  onHint?: (message: string) => void;
  /** Disconnected sessions beyond this are dropped, oldest first. Default 20. */
  maxSessions?: number;
  /** Default 5000. `state.*` events are kept apart; see `maxStateEvents`. */
  maxEventsPerSession?: number;
  /**
   * `state.change` and `state.entries` events kept per session, apart from the others so busy stores cannot
   * push logs and requests out. The latest `state.store` of each store is kept regardless. Default 2000.
   */
  maxStateEvents?: number;
  /** Milliseconds to wait for an app to answer a command. Default 10s. */
  commandTimeout?: number;
  version?: string;
  /**
   * Looks up the newest CLI and SDK versions (e.g. `fetchLatestVersions`), so the UI can say what is
   * out of date. Called once the server is listening, then twice a day. Without it nothing is looked up.
   */
  latestVersions?: () => Promise<LatestVersions | undefined>;
}

export interface CapybaraServer {
  /** `address` is the one the server listens on, `::` or `0.0.0.0` for all interfaces. */
  start(): Promise<{ port: number; address: string }>;
  close(): Promise<void>;
}

interface Session {
  info: SessionInfo;
  events: CapybaraEvent[];
  /** Kept apart from `events`, where busy stores would push out the logs and requests `diagnose` looks up. */
  state: {
    /** `state.change` and `state.entries`. */
    events: CapybaraEvent[];
    /** The latest `state.store` of each store, by store id, oldest first. */
    stores: Map<string, EventOf<'state.store'>>;
  };
  lastSeq: number;
  socket: WebSocket | null;
  lastSeen: number;
  /** Set while a batch waits for Metro to map its stacks; later batches and clears wait behind it. */
  queue?: Promise<void>;
}

interface PendingCommand {
  viewer: WebSocket;
  viewerId: string;
  sessionId: string;
  timer: ReturnType<typeof setTimeout>;
}

/** Apps killed without a close frame (force-quit, lost Wi-Fi) are only noticed by missing pongs. */
const HEARTBEAT_MS = 15_000;
const LATEST_REFRESH_MS = 12 * 60 * 60 * 1_000;
const MAX_PINNED_STORES = 200;

export function createServer(options: ServerOptions): CapybaraServer {
  const maxSessions = options.maxSessions ?? 20;
  const maxEvents = options.maxEventsPerSession ?? 5_000;
  const maxStateEvents = options.maxStateEvents ?? 2_000;
  const commandTimeout = options.commandTimeout ?? 10_000;
  const allowedOrigins = options.allowedOrigins ?? [];
  const sessions = new Map<string, Session>();
  const viewers = new Set<WebSocket>();
  const pending = new Map<string, PendingCommand>();
  const alive = new WeakMap<WebSocket, boolean>();
  let commandCounter = 0;
  let port = options.port;
  let bound = '';
  let latest: LatestVersions | undefined;
  let latestTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const closing = new AbortController();

  const mayView = (req: http.IncomingMessage) => options.remoteUi === true || isLocalConnection(req.socket);
  const hinted = new Set<string>();
  // Whoever tried probably sits at this computer too, and may not know about --remote-ui.
  const refused = (req: http.IncomingMessage) => {
    const address = unmapped(req.socket.remoteAddress) ?? 'A device';
    if (hinted.has(address)) return;
    hinted.add(address);
    options.onHint?.(
      `${address} was turned away: only this computer can open the UI or read it with capybara mcp. ` +
        'Restart with --remote-ui to let other devices in; they then see everything apps send, tokens included.',
    );
  };

  const httpServer = http.createServer((req, res) => {
    if (!isAllowedHost(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden host');
      return;
    }
    if (!mayView(req)) {
      refused(req);
      refuseRemote(res);
      return;
    }
    serveStatic(req, res, options.uiDir);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });

  httpServer.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === CLIENT_PATH) {
      // Apps connect from anywhere on the LAN; they can only add events, never read them.
      wss.handleUpgrade(req, socket, head, acceptClient);
    } else if (
      path === VIEWER_PATH &&
      mayView(req) &&
      isAllowedHost(req.headers.host) &&
      isAllowedViewerOrigin(req.headers.origin, req.headers.host, allowedOrigins)
    ) {
      wss.handleUpgrade(req, socket, head, acceptViewer);
    } else {
      if (path === VIEWER_PATH && !mayView(req)) refused(req);
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const watch = (ws: WebSocket) => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
  };

  const send = (ws: WebSocket, message: ServerToClient | ServerToViewer) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };

  const broadcast = (message: ServerToViewer) => {
    if (viewers.size === 0) return;
    const data = JSON.stringify(message);
    for (const viewer of viewers) if (viewer.readyState === WebSocket.OPEN) viewer.send(data);
  };

  const meta = (s: Session): SessionMeta => ({
    info: s.info,
    connected: s.socket !== null,
    lastSeen: s.lastSeen,
    eventCount: s.events.length + s.state.events.length + s.state.stores.size,
  });

  // The UI skips events at or below the last seq it applied, so the three lists must merge in seq order.
  const history = (s: Session): CapybaraEvent[] =>
    [...s.events, ...s.state.stores.values(), ...s.state.events].sort((a, b) => a.seq - b.seq);

  const serverInfo = (): ServerInfo => ({
    version: options.version ?? '0.0.0',
    port,
    addresses: reachableAddresses(bound),
    remoteUi: options.remoteUi === true,
    latest,
  });

  const refreshLatest = async () => {
    const found = await options.latestVersions?.().catch(() => undefined);
    if (!found || closed || JSON.stringify(found) === JSON.stringify(latest)) return;
    latest = found;
    broadcast({ t: 'server', server: serverInfo() });
  };

  const prune = () => {
    if (sessions.size <= maxSessions) return;
    const idle = [...sessions.values()].filter((s) => !s.socket).sort((a, b) => a.lastSeen - b.lastSeen);
    for (const s of idle) {
      if (sessions.size <= maxSessions) break;
      sessions.delete(s.info.id);
      broadcast({ t: 'session.removed', sessionId: s.info.id });
    }
  };

  const finish = (id: string, result: CommandResult) => {
    const command = pending.get(id);
    if (!command) return;
    clearTimeout(command.timer);
    pending.delete(id);
    send(command.viewer, { ...result, id: command.viewerId });
  };

  // ---------------------------------------------------------------------------
  // Apps
  // ---------------------------------------------------------------------------

  const attach = (info: SessionInfo, ws: WebSocket): Session => {
    let session = sessions.get(info.id);
    if (session) {
      if (session.socket && session.socket !== ws) session.socket.close();
      session.socket = ws;
      session.info = info;
    } else {
      session = {
        info,
        events: [],
        state: { events: [], stores: new Map() },
        lastSeq: 0,
        socket: ws,
        lastSeen: Date.now(),
      };
      sessions.set(info.id, session);
    }
    session.lastSeen = Date.now();
    broadcast({ t: 'session', session: meta(session) });
    prune();
    return session;
  };

  const pin = (stores: Session['state']['stores'], event: EventOf<'state.store'>) => {
    const { id } = event.payload.store;
    // Re-inserting moves the store to the end, so the map stays oldest first.
    stores.delete(id);
    stores.set(id, event);
    if (stores.size <= MAX_PINNED_STORES) return;
    const pinned = [...stores.values()];
    // Disposed stores are gone from the app, so they make way before live ones.
    const stale = pinned.find((kept) => kept.payload.store.disposed) ?? pinned[0]!;
    stores.delete(stale.payload.store.id);
  };

  const keep = (session: Session, event: CapybaraEvent) => {
    if (!event.kind.startsWith('state.')) {
      session.events.push(event);
    } else if (event.kind === 'state.store' && typeof event.payload?.store?.id === 'string') {
      pin(session.state.stores, event);
    } else {
      // Also takes registrations without a store id: payloads arrive unchecked, and those cannot be pinned.
      session.state.events.push(event);
    }
  };

  const ingest = (session: Session, events: unknown) => {
    if (!Array.isArray(events)) return;
    const fresh: CapybaraEvent[] = [];
    // After a reconnect the app replays from its buffer; anything at or below lastSeq is a duplicate.
    for (const event of events as CapybaraEvent[]) {
      if (event && typeof event.seq === 'number' && typeof event.kind === 'string' && event.seq > session.lastSeq) {
        fresh.push(event);
        session.lastSeq = event.seq;
      }
    }
    if (fresh.length === 0) return;
    if (!session.queue && !hasBundleFrames(fresh)) {
      store(session, fresh);
      return;
    }
    inOrder(session, async () => {
      await symbolicateEvents(fresh, { signal: closing.signal }).catch(() => {});
      // The session may have been removed while Metro was answering.
      if (sessions.get(session.info.id) === session && !closed) store(session, fresh);
    });
  };

  const store = (session: Session, fresh: CapybaraEvent[]) => {
    for (const event of fresh) keep(session, event);
    if (session.events.length > maxEvents) session.events.splice(0, session.events.length - maxEvents);
    const timeline = session.state.events;
    if (timeline.length > maxStateEvents) timeline.splice(0, timeline.length - maxStateEvents);
    session.lastSeen = Date.now();
    broadcast({ t: 'events', sessionId: session.info.id, events: fresh });
  };

  /** Runs `task` once the batches still waiting for Metro are stored, so nothing overtakes them. */
  const inOrder = (session: Session, task: () => void | Promise<void>) => {
    const queued = (session.queue ?? Promise.resolve()).then(task).catch(() => {});
    session.queue = queued;
    void queued.then(() => {
      if (session.queue === queued) session.queue = undefined;
    });
  };

  const acceptClient = (ws: WebSocket) => {
    watch(ws);
    let session: Session | undefined;

    ws.on('message', (raw) => {
      const message = parse<ClientToServer>(raw);
      if (!message) return;
      if (message.t === 'hello') {
        if (message.protocol !== PROTOCOL_VERSION) {
          send(ws, {
            t: 'reject',
            reason: `protocol ${String(message.protocol)} is not supported; this server speaks ${PROTOCOL_VERSION}`,
          });
          ws.close();
          return;
        }
        if (!isSessionInfo(message.session)) {
          ws.close();
          return;
        }
        session = attach(message.session, ws);
        send(ws, { t: 'welcome', lastSeq: session.lastSeq });
        return;
      }
      const current = session;
      if (!current) return;
      if (message.t === 'events') {
        ingest(current, message.events);
      } else if (message.t === 'result') {
        if (pending.get(message.id)?.sessionId === current.info.id) finish(message.id, message);
      }
    });

    ws.on('close', () => {
      const current = session;
      if (!current || current.socket !== ws) return;
      current.socket = null;
      current.lastSeen = Date.now();
      broadcast({ t: 'session', session: meta(current) });
      for (const [id, command] of pending) {
        if (command.sessionId === current.info.id) finish(id, { t: 'result', id, ok: false, error: 'The app disconnected' });
      }
      prune();
    });
  };

  // ---------------------------------------------------------------------------
  // Viewers (the UI)
  // ---------------------------------------------------------------------------

  const forward = (viewer: WebSocket, message: Extract<ViewerToServer, { t: 'command' }>) => {
    const session = sessions.get(message.sessionId);
    if (!session?.socket || session.socket.readyState !== WebSocket.OPEN) {
      send(viewer, { t: 'result', id: message.id, ok: false, error: 'The app is not connected' });
      return;
    }
    // Ids from different viewers could collide, so the app only ever sees server-issued ones.
    const id = `c${++commandCounter}`;
    const timer = setTimeout(
      () => finish(id, { t: 'result', id, ok: false, error: 'The app did not answer in time' }),
      commandTimeout,
    );
    pending.set(id, { viewer, viewerId: message.id, sessionId: session.info.id, timer });
    send(session.socket, { t: 'command', id, plugin: message.plugin, method: message.method, params: message.params });
  };

  const diagnose = async (viewer: WebSocket, message: Extract<ViewerToServer, { t: 'diagnose' }>) => {
    const fail = (error: string) => send(viewer, { t: 'result', id: message.id, ok: false, error });
    const session = sessions.get(message.sessionId);
    const find = <K extends 'network.request' | 'network.error'>(kind: K) =>
      session?.events.find((event): event is EventOf<K> => event.kind === kind && event.payload.id === message.requestId);
    const request = find('network.request');
    if (!session || !request) return fail('This request is no longer in the session');
    if (!session.info.url) return fail('Only requests from web pages can be checked; CORS applies only in browsers');
    try {
      const result = await diagnoseRequest({
        url: new URL(request.payload.url, session.info.url).href,
        method: request.payload.method,
        headers: request.payload.headers,
        origin: new URL(session.info.url).origin,
        credentials: find('network.error')?.payload.credentials === true,
        userAgent: session.info.userAgent,
      });
      send(viewer, { t: 'result', id: message.id, ok: true, result });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  };

  const acceptViewer = (ws: WebSocket) => {
    watch(ws);
    viewers.add(ws);
    send(ws, { t: 'init', server: serverInfo(), sessions: [...sessions.values()].map(meta) });

    ws.on('message', (raw) => {
      const message = parse<ViewerToServer>(raw);
      if (!message) return;
      switch (message.t) {
        case 'history': {
          const session = sessions.get(message.sessionId);
          send(ws, { t: 'history', sessionId: message.sessionId, events: session ? history(session) : [] });
          break;
        }
        case 'command':
          forward(ws, message);
          break;
        case 'diagnose':
          void diagnose(ws, message);
          break;
        case 'clear': {
          const session = sessions.get(message.sessionId);
          if (!session) break;
          const scope = message.scope === 'state' ? 'state' : undefined;
          const clear = () => {
            // lastSeq stays, so events the app replays later are still recognised as already seen.
            if (!scope) session.events = [];
            // Registered stores stay: the app still has them, and their current state can still be read.
            session.state.events = [];
            broadcast(scope ? { t: 'cleared', sessionId: message.sessionId, scope } : { t: 'cleared', sessionId: message.sessionId });
          };
          // Batches waiting for Metro arrived before the clear, so they are cleared too.
          if (session.queue) inOrder(session, clear);
          else clear();
          break;
        }
        case 'remove': {
          const session = sessions.get(message.sessionId);
          if (!session || session.socket) break;
          sessions.delete(message.sessionId);
          broadcast({ t: 'session.removed', sessionId: message.sessionId });
          break;
        }
      }
    });

    ws.on('close', () => {
      viewers.delete(ws);
      for (const [id, command] of pending) {
        if (command.viewer !== ws) continue;
        clearTimeout(command.timer);
        pending.delete(id);
      }
    });
  };

  return {
    start: () =>
      new Promise((resolve, reject) => {
        const onError = (error: Error) => {
          httpServer.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.off('error', onError);
          const address = httpServer.address();
          if (address && typeof address === 'object') {
            port = address.port;
            bound = address.address;
          }
          if (options.latestVersions) {
            void refreshLatest();
            latestTimer = setInterval(() => void refreshLatest(), LATEST_REFRESH_MS);
            latestTimer.unref();
          }
          resolve({ port, address: bound });
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        if (options.host) httpServer.listen(options.port, options.host);
        else httpServer.listen(options.port);
      }),

    close: () =>
      new Promise((resolve) => {
        closed = true;
        closing.abort();
        clearInterval(heartbeat);
        clearInterval(latestTimer);
        for (const command of pending.values()) clearTimeout(command.timer);
        pending.clear();
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      }),
  };
}

/** Where phones on the network reach a server listening on `bound`: nowhere when that is loopback. */
export function reachableAddresses(bound: string): string[] {
  if (bound === '::' || bound === '0.0.0.0') return lanAddresses();
  return isIPv4(bound) && !isLoopbackAddress(bound) ? [bound] : [];
}

export function lanAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

function parse<T extends { t: string }>(raw: RawData): T | undefined {
  try {
    const value = JSON.parse(raw.toString()) as unknown;
    return value && typeof value === 'object' && typeof (value as { t?: unknown }).t === 'string' ? (value as T) : undefined;
  } catch {
    return undefined;
  }
}

function isSessionInfo(value: unknown): value is SessionInfo {
  const info = value as Partial<SessionInfo> | null;
  return (
    !!info &&
    typeof info.id === 'string' &&
    info.id.length > 0 &&
    info.id.length <= 200 &&
    typeof info.appName === 'string' &&
    typeof info.platform === 'string'
  );
}
