import {
  PROTOCOL_VERSION,
  type ClientToServer,
  type CommandResult,
  type EventKind,
  type EventPayloads,
  type LogLevel,
  type SerializedValue,
  type ServerToClient,
  type SessionInfo,
} from '@capybara-devtools/protocol';
import { serialize, type SerializeOptions } from './serialize.js';
import { Connection, nativeSocketFactory, type SocketFactory } from './transport.js';
import { errorMessage, randomId } from './utils.js';

type ConsoleMethod = (...args: unknown[]) => void;

export interface PluginContext {
  /** `ts` dates the event when it happened earlier than now, e.g. a state change sent in a later batch. */
  emit<K extends EventKind>(kind: K, payload: EventPayloads[K], ts?: number): void;
  serialize(value: unknown): SerializedValue;
  /** Console methods saved before any plugin patched them. SDK diagnostics written here are not captured. */
  console: { log: ConsoleMethod; warn: ConsoleMethod; error: ConsoleMethod };
}

export interface Plugin {
  name: string;
  /** Install hooks. The returned function must undo them. */
  setup?(ctx: PluginContext): void | (() => void);
  /** Handlers for commands sent from the UI, keyed by method name. */
  commands?: Record<string, (params: any) => unknown>;
}

export interface ClientOptions {
  /** e.g. `ws://192.168.1.5:7357/client` */
  url: string;
  session: Omit<SessionInfo, 'id' | 'startedAt' | 'plugins'>;
  plugins?: Plugin[];
  /** Events kept for replay after a reconnect. Default 2000. */
  maxBufferEvents?: number;
  /** Approximate size cap of the replay buffer in characters. Default 8 MiB. */
  maxBufferBytes?: number;
  /** Milliseconds to batch events before sending. Default 50. */
  flushInterval?: number;
  serializeOptions?: SerializeOptions;
  socketFactory?: SocketFactory;
}

export interface CapybaraClient {
  readonly session: SessionInfo;
  /** True once the server has acknowledged this session. */
  readonly connected: boolean;
  /** Log without going through `console`, e.g. from a custom logger. */
  log(level: LogLevel, ...args: unknown[]): void;
  /** Restores patched globals and closes the connection. */
  stop(): void;
}

/** Where the active client lives on `globalThis`. The Metro bridge checks it to leave apps with the SDK alone. */
export const CLIENT_GLOBAL = '__CAPYBARA_CLIENT__';
const MAX_BATCH_EVENTS = 200;
const MAX_BATCH_CHARS = 512 * 1024;

interface Buffered {
  seq: number;
  json: string;
}

export function getActiveClient(): CapybaraClient | undefined {
  return (globalThis as Record<string, unknown>)[CLIENT_GLOBAL] as CapybaraClient | undefined;
}

export function createClient(options: ClientOptions): CapybaraClient {
  // Two clients would patch console and network twice.
  getActiveClient()?.stop();

  const plugins = options.plugins ?? [];
  const session: SessionInfo = {
    ...options.session,
    id: randomId(),
    startedAt: Date.now(),
    plugins: plugins.map((p) => p.name),
  };
  const maxEvents = options.maxBufferEvents ?? 2_000;
  const maxChars = options.maxBufferBytes ?? 8 * 1024 * 1024;
  const flushInterval = options.flushInterval ?? 50;
  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  // Events are stringified once when recorded, so replaying them after a reconnect costs nothing extra.
  const buffer: Buffered[] = [];
  let bufferChars = 0;
  let seq = 0;
  let sentSeq = 0;
  let ready = false;
  let stopped = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushQueued = false;

  const serializeValue = (value: unknown) => serialize(value, options.serializeOptions);

  const send = (message: ClientToServer) => connection.send(JSON.stringify(message));

  const emit: PluginContext['emit'] = (kind, payload, ts) => {
    if (stopped) return;
    let json: string;
    try {
      json = JSON.stringify({ seq: seq + 1, ts: ts ?? Date.now(), kind, payload });
    } catch {
      return;
    }
    seq++;
    buffer.push({ seq, json });
    bufferChars += json.length;
    while (buffer.length > 1 && (buffer.length > maxEvents || bufferChars > maxChars)) {
      bufferChars -= buffer.shift()!.json.length;
    }
    scheduleFlush();
  };

  const scheduleFlush = () => {
    if (!ready || flushQueued) return;
    // Browsers run the timers of a hidden tab once a second at most, Chrome once a minute after a while, and the
    // developer reading Capybara in another tab hides the app's. A microtask is not held back, and still sends what
    // one task records together.
    if (isPageHidden()) {
      if (flushTimer !== null) clearTimeout(flushTimer);
      flushTimer = null;
      flushQueued = true;
      queueMicrotask(flush);
    } else if (flushTimer === null) {
      flushTimer = setTimeout(flush, flushInterval);
    }
  };

  const indexAfter = (afterSeq: number) => {
    let i = buffer.length;
    while (i > 0 && buffer[i - 1]!.seq > afterSeq) i--;
    return i;
  };

  const flush = () => {
    flushTimer = null;
    flushQueued = false;
    if (!ready) return;
    let i = indexAfter(sentSeq);
    while (i < buffer.length) {
      const parts: string[] = [];
      let chars = 0;
      while (i < buffer.length && parts.length < MAX_BATCH_EVENTS && (parts.length === 0 || chars < MAX_BATCH_CHARS)) {
        const item = buffer[i]!;
        parts.push(item.json);
        chars += item.json.length;
        i++;
      }
      // Leave sentSeq alone on failure; the events go out again after the next welcome.
      if (!connection.send(`{"t":"events","events":[${parts.join(',')}]}`)) return;
      sentSeq = buffer[i - 1]!.seq;
    }
  };

  const handleCommand = async (id: string, pluginName: string, method: string, params: unknown) => {
    const handler = plugins.find((p) => p.name === pluginName)?.commands?.[method];
    let reply: CommandResult;
    if (!handler) {
      reply = { t: 'result', id, ok: false, error: `Unknown command ${pluginName}.${method}` };
    } else {
      try {
        reply = { t: 'result', id, ok: true, result: await handler(params) };
      } catch (error) {
        reply = { t: 'result', id, ok: false, error: errorMessage(error) };
      }
    }
    try {
      send(reply);
    } catch (error) {
      send({ t: 'result', id, ok: false, error: `Result could not be serialized: ${errorMessage(error)}` });
    }
  };

  // Created before plugins run, so WebSocket capture never wraps the SDK's own connection.
  const connection = new Connection(options.url, options.socketFactory ?? nativeSocketFactory(), {
    onOpen: () => {
      send({ t: 'hello', protocol: PROTOCOL_VERSION, session });
    },
    onMessage: (data) => {
      let message: ServerToClient;
      try {
        message = JSON.parse(data) as ServerToClient;
      } catch {
        return;
      }
      switch (message.t) {
        case 'welcome':
          sentSeq = message.lastSeq;
          ready = true;
          flush();
          break;
        case 'command':
          void handleCommand(message.id, message.plugin, message.method, message.params);
          break;
        case 'reject':
          originalConsole.warn(`[capybara] Server rejected this app: ${message.reason}`);
          connection.stop();
          break;
      }
    },
    onClose: () => {
      ready = false;
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
    },
  });

  const ctx: PluginContext = { emit, serialize: serializeValue, console: originalConsole };
  const teardowns: Array<() => void> = [];
  for (const plugin of plugins) {
    try {
      const teardown = plugin.setup?.(ctx);
      if (typeof teardown === 'function') teardowns.push(teardown);
    } catch (error) {
      originalConsole.warn(`[capybara] Plugin "${plugin.name}" failed to start:`, error);
    }
  }

  const client: CapybaraClient = {
    session,
    get connected() {
      return ready;
    },
    log(level, ...args) {
      emit('log', { level, source: 'api', args: args.map(serializeValue) });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      ready = false;
      if (flushTimer !== null) clearTimeout(flushTimer);
      for (const teardown of teardowns.reverse()) {
        try {
          teardown();
        } catch {
          // keep tearing down the rest
        }
      }
      connection.stop();
      if (getActiveClient() === client) delete (globalThis as Record<string, unknown>)[CLIENT_GLOBAL];
    },
  };

  (globalThis as Record<string, unknown>)[CLIENT_GLOBAL] = client;
  connection.start();
  return client;
}

/** React Native has no document, and its timers keep their pace. */
function isPageHidden(): boolean {
  return (globalThis as { document?: { visibilityState?: string } }).document?.visibilityState === 'hidden';
}
