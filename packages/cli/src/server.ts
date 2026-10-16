import http from 'node:http';
import { networkInterfaces } from 'node:os';
import {
  CLIENT_PATH,
  PROTOCOL_VERSION,
  VIEWER_PATH,
  type ClientToServer,
  type CommandResult,
  type DevsightEvent,
  type ServerInfo,
  type ServerToClient,
  type ServerToViewer,
  type SessionInfo,
  type SessionMeta,
  type ViewerToServer,
} from '@devsight/protocol';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { isAllowedHost, isAllowedViewerOrigin } from './security.js';
import { serveStatic } from './static.js';

export { reverseAndroidPorts } from './adb.js';
export { DEFAULT_METRO_PORTS, startMetroBridge, type MetroBridge, type MetroBridgeOptions } from './metro.js';

export interface ServerOptions {
  /** 0 picks a free port. */
  port: number;
  /** Address to bind. Default: all interfaces, so phones on the same network can connect. */
  host?: string;
  /** Directory with the built UI. Without one a placeholder page is served. */
  uiDir?: string;
  /** Extra origins allowed to open the viewer socket, e.g. the Vite dev server for the UI. */
  allowedOrigins?: string[];
  /** Disconnected sessions beyond this are dropped, oldest first. Default 20. */
  maxSessions?: number;
  /** Default 5000. */
  maxEventsPerSession?: number;
  /** Milliseconds to wait for an app to answer a command. Default 10s. */
  commandTimeout?: number;
  version?: string;
}

export interface DevsightServer {
  start(): Promise<{ port: number }>;
  close(): Promise<void>;
}

interface Session {
  info: SessionInfo;
  events: DevsightEvent[];
  lastSeq: number;
  socket: WebSocket | null;
  lastSeen: number;
}

interface PendingCommand {
  viewer: WebSocket;
  viewerId: string;
  sessionId: string;
  timer: ReturnType<typeof setTimeout>;
}

/** Apps killed without a close frame (force-quit, lost Wi-Fi) are only noticed by missing pongs. */
const HEARTBEAT_MS = 15_000;

export function createServer(options: ServerOptions): DevsightServer {
  const maxSessions = options.maxSessions ?? 20;
  const maxEvents = options.maxEventsPerSession ?? 5_000;
  const commandTimeout = options.commandTimeout ?? 10_000;
  const allowedOrigins = options.allowedOrigins ?? [];
  const sessions = new Map<string, Session>();
  const viewers = new Set<WebSocket>();
  const pending = new Map<string, PendingCommand>();
  const alive = new WeakMap<WebSocket, boolean>();
  let commandCounter = 0;
  let port = options.port;

  const httpServer = http.createServer((req, res) => {
    if (!isAllowedHost(req.headers.host)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden host');
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
      isAllowedHost(req.headers.host) &&
      isAllowedViewerOrigin(req.headers.origin, req.headers.host, allowedOrigins)
    ) {
      wss.handleUpgrade(req, socket, head, acceptViewer);
    } else {
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
    eventCount: s.events.length,
  });

  const serverInfo = (): ServerInfo => ({ version: options.version ?? '0.0.0', port, addresses: lanAddresses() });

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
      session = { info, events: [], lastSeq: 0, socket: ws, lastSeen: Date.now() };
      sessions.set(info.id, session);
    }
    session.lastSeen = Date.now();
    broadcast({ t: 'session', session: meta(session) });
    prune();
    return session;
  };

  const ingest = (session: Session, events: unknown) => {
    if (!Array.isArray(events)) return;
    const fresh: DevsightEvent[] = [];
    // After a reconnect the app replays from its buffer; anything at or below lastSeq is a duplicate.
    for (const event of events as DevsightEvent[]) {
      if (event && typeof event.seq === 'number' && typeof event.kind === 'string' && event.seq > session.lastSeq) {
        fresh.push(event);
        session.lastSeq = event.seq;
      }
    }
    if (fresh.length === 0) return;
    for (const event of fresh) session.events.push(event);
    if (session.events.length > maxEvents) session.events.splice(0, session.events.length - maxEvents);
    session.lastSeen = Date.now();
    broadcast({ t: 'events', sessionId: session.info.id, events: fresh });
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
          send(ws, { t: 'history', sessionId: message.sessionId, events: session?.events ?? [] });
          break;
        }
        case 'command':
          forward(ws, message);
          break;
        case 'clear': {
          const session = sessions.get(message.sessionId);
          if (!session) break;
          // lastSeq stays, so events the app replays later are still recognised as already seen.
          session.events = [];
          broadcast({ t: 'cleared', sessionId: message.sessionId });
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
          if (address && typeof address === 'object') port = address.port;
          resolve({ port });
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        if (options.host) httpServer.listen(options.port, options.host);
        else httpServer.listen(options.port);
      }),

    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        for (const command of pending.values()) clearTimeout(command.timer);
        pending.clear();
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      }),
  };
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
