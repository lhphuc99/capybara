import { randomUUID } from 'node:crypto';
import { CLIENT_GLOBAL, serialize } from '@devsight/core';
import {
  CLIENT_PATH,
  METRO_SDK,
  PROTOCOL_VERSION,
  type BodyPreview,
  type EventKind,
  type EventPayloads,
  type SerializedValue,
  type ServerToClient,
  type SessionInfo,
} from '@devsight/protocol';
import { WebSocket, type RawData } from 'ws';
import { readMetroStorage } from './metro-storage.js';
import { watchMetroMMKV } from './metro-mmkv.js';
import { parseWebSocketReport, watchMetroWebSockets, WEBSOCKET_BINDING } from './metro-websocket.js';
import {
  headerValue,
  initiatorOf,
  isDevServerRequest,
  isTextual,
  isUnhandledRejection,
  logLevel,
  platformOf,
  primitiveValue,
  responseBody,
  textBody,
  type RemoteObject,
} from './cdp.js';

/** Expo moves to 8082 when 8081 is taken. */
export const DEFAULT_METRO_PORTS = [8081, 8082];

export interface MetroBridgeOptions {
  /** Port of the Devsight server the apps are reported to. */
  port: number;
  metroPorts?: number[];
  /** Reported as the SDK version of these sessions. */
  version?: string;
  /** Milliseconds between looks for apps. Default 2000. */
  pollInterval?: number;
}

export interface MetroBridge {
  stop(): void;
}

const CALL_TIMEOUT_MS = 3_000;
/** Expo's dev server accepts a debugger socket and drops it right away when the Origin isn't its own address. */
const ORIGIN_CHECK_MS = 300;
const RETRY_AFTER_FAILURE_MS = 30_000;
/** A starting app is checked this often for the SDK until its entry file has run. */
const STARTUP_CHECK_MS = 1_000;
const STARTUP_LIMIT_MS = 30_000;
const MAX_BODY_FETCH = 4 * 1024 * 1024;
const MAX_HELD_EVENTS = 2_000;
const MAX_SOCKET_MESSAGE = 16 * 1024;

const SERIALIZER_GLOBAL = '__DEVSIGHT_SERIALIZE__';
const INSTALL_SERIALIZER = `globalThis.${SERIALIZER_GLOBAL} = ${serialize.toString()}`;
/** Returns null until the serializer is installed in this JS context, e.g. right after a reload. */
const SERIALIZE_ARGS = `function () {
  var serialize = globalThis.${SERIALIZER_GLOBAL};
  if (typeof serialize !== 'function') return null;
  var out = [];
  for (var i = 0; i < arguments.length; i++) out.push(serialize(arguments[i]));
  return JSON.stringify(out);
}`;
/**
 * `sdk`: the app reports itself and is left alone. `ready`: the entry file has run, so an SDK would
 * be set up by now (React Native only loads AppRegistry once the app registers its root component).
 * `name`: the Expo project, since Expo Go calls every project "Expo".
 */
const PROBE_APP = `JSON.stringify({
  sdk: typeof globalThis.${CLIENT_GLOBAL} === 'object' && globalThis.${CLIENT_GLOBAL} !== null,
  ready: typeof globalThis.RN$AppRegistry !== 'undefined',
  name: (function () {
    try {
      var manifest = globalThis.expo.modules.ExponentConstants.manifest;
      if (typeof manifest === 'string') manifest = JSON.parse(manifest);
      return manifest.name || manifest.extra.expoClient.name || null;
    } catch (error) {
      return null;
    }
  })()
})`;

/** One entry of Metro's `/json/list`. */
interface MetroTarget {
  id: string;
  title?: string;
  appId?: string;
  deviceName?: string;
  webSocketDebuggerUrl?: string;
  reactNative?: { capabilities?: { supportsMultipleDebuggers?: boolean } };
}

interface AppMetadata {
  appDisplayName?: string;
  deviceName?: string;
  platform?: string;
  reactNativeVersion?: string;
}

interface CdpEvent {
  method: string;
  params: unknown;
}

interface CdpReply {
  result?: unknown;
  error?: { message: string };
}

interface EvaluateResult {
  result?: { value?: unknown };
}

interface ConsoleCall {
  type: string;
  args: RemoteObject[];
  executionContextId: number;
  timestamp?: number;
}

interface ExceptionThrown {
  timestamp?: number;
  exceptionDetails: { text?: string; exception?: RemoteObject; executionContextId?: number };
}

interface RequestSent {
  requestId: string;
  type?: string;
  timestamp: number;
  wallTime?: number;
  request: { url: string; method: string; headers?: Record<string, string>; postData?: string };
}

interface ResponseReceived {
  requestId: string;
  timestamp: number;
  response: { status: number; statusText?: string; headers?: Record<string, string>; mimeType?: string };
}

interface LoadingFinished {
  requestId: string;
  timestamp: number;
  encodedDataLength?: number;
}

interface LoadingFailed {
  requestId: string;
  timestamp: number;
  errorText?: string;
  canceled?: boolean;
}

interface Session {
  emit<K extends EventKind>(kind: K, payload: EventPayloads[K], ts?: number): void;
  close(): void;
}

interface Request {
  start: number;
  ignored: boolean;
  response?: ResponseReceived['response'];
  responseAt?: number;
}

/** One JS context of the app: a launch or a reload. */
interface Run {
  contextId: number;
  startedAt: number;
  state: 'deciding' | 'skipped' | 'streaming';
  /** Events held until it is known whether the app has the SDK. */
  held: CdpEvent[];
  checking: boolean;
  sawRunning: boolean;
  retry?: ReturnType<typeof setTimeout>;
  session?: Session;
  mmkv?: ReturnType<typeof watchMetroMMKV>;
  sockets?: ReturnType<typeof watchMetroWebSockets>;
  requests: Map<string, Request>;
}

/**
 * Reads logs and network of React Native apps through Metro's debugger endpoint, the one React
 * Native DevTools uses, so apps show up without the SDK. Apps that have the SDK are left alone.
 */
export function startMetroBridge(options: MetroBridgeOptions): MetroBridge {
  const metroPorts = options.metroPorts ?? DEFAULT_METRO_PORTS;
  const interval = options.pollInterval ?? 2_000;
  const devsightUrl = `ws://127.0.0.1:${options.port}${CLIENT_PATH}`;
  const version = options.version ?? '0.0.0';
  const apps = new Map<string, { close(): void }>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scan = async (metroPort: number) => {
    for (const target of (await listTargets(metroPort)) ?? []) {
      // Without this capability a second debugger would disconnect React Native DevTools.
      if (!target?.reactNative?.capabilities?.supportsMultipleDebuggers ||
          typeof target.id !== 'string' || typeof target.webSocketDebuggerUrl !== 'string') continue;
      const key = `${metroPort} ${target.id}`;
      if (stopped || apps.has(key)) continue;
      apps.set(key, watchApp(target, metroPort, devsightUrl, version, () => apps.delete(key)));
    }
  };

  const poll = async () => {
    await Promise.all(metroPorts.map(scan));
    if (stopped) return;
    timer = setTimeout(poll, interval);
    timer.unref();
  };
  void poll();

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      for (const app of [...apps.values()]) app.close();
    },
  };
}

async function listTargets(metroPort: number): Promise<MetroTarget[] | undefined> {
  try {
    const response = await fetch(`http://localhost:${metroPort}/json/list`, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return undefined;
    const list = (await response.json()) as unknown;
    return Array.isArray(list) ? (list as MetroTarget[]) : undefined;
  } catch {
    return undefined;
  }
}

function watchApp(
  target: MetroTarget,
  metroPort: number,
  devsightUrl: string,
  version: string,
  onEnd: () => void,
): { close(): void } {
  let socket: WebSocket | undefined;
  let nextId = 0;
  const calls = new Map<number, (reply: CdpReply) => void>();
  let metadata: AppMetadata = {};
  let run: Run | undefined;
  // Processing is sequential so events reach the UI in the order the app produced them.
  let queue: Promise<void> = Promise.resolve();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  const controller = new AbortController();

  const call = <T>(method: string, params: object = {}): Promise<T> =>
    new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected'));
        return;
      }
      const id = ++nextId;
      const timer = setTimeout(() => {
        calls.delete(id);
        reject(new Error(`${method} timed out`));
      }, CALL_TIMEOUT_MS);
      calls.set(id, (reply) => {
        clearTimeout(timer);
        if (reply.error) reject(new Error(reply.error.message));
        else resolve(reply.result as T);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });

  // Object handles stay alive in the app until released.
  const release = (objects: RemoteObject[]) => {
    for (const object of objects) {
      if (object.objectId) call('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
    }
  };

  const releaseEvent = (event: CdpEvent) => {
    if (event.method === 'Runtime.consoleAPICalled') release((event.params as ConsoleCall).args);
    if (event.method === 'Runtime.exceptionThrown') {
      const exception = (event.params as ExceptionThrown).exceptionDetails.exception;
      if (exception) release([exception]);
    }
  };

  const end = () => {
    if (ended) return;
    ended = true;
    controller.abort();
    clearTimeout(retryTimer);
    // Give the runtime a chance to restore its methods before closing CDP. A lease in the app
    // also expires the hooks if the socket has already disappeared or the process is killed.
    void endRun().finally(() => {
      socket?.close();
      for (const reply of calls.values()) reply({ error: { message: 'Closed' } });
      calls.clear();
      onEnd();
    });
  };

  const sessionInfo = (projectName: string | null | undefined): SessionInfo => {
    const platform = platformOf(metadata.platform);
    const model = metadata.deviceName || target.deviceName;
    return {
      id: randomUUID(),
      appName: projectName || metadata.appDisplayName || target.appId || target.title || 'React Native app',
      platform,
      sdk: { name: METRO_SDK, version },
      startedAt: Date.now(),
      device: {
        model,
        isEmulator: platform === 'android' && /sdk_gphone|emulator|generic/i.test(model ?? '') ? true : undefined,
      },
      runtime: ['Hermes', metadata.reactNativeVersion && `RN ${metadata.reactNativeVersion}`, 'via Metro']
        .filter(Boolean)
        .join(' · '),
    };
  };

  const startRun = (contextId: number) => {
    void endRun();
    const current: Run = {
      contextId,
      startedAt: Date.now(),
      state: 'deciding',
      held: [],
      checking: false,
      sawRunning: false,
      requests: new Map(),
    };
    run = current;
    void decide(current);
  };

  const endRun = () => {
    const current = run;
    if (!current) return Promise.resolve();
    run = undefined;
    clearTimeout(current.retry);
    for (const event of current.held) releaseEvent(event);
    current.held = [];
    current.session?.close();
    current.requests.clear();
    return Promise.all([current.mmkv?.stop(), current.sockets?.stop()]).then(() => {});
  };

  const decide = async (current: Run) => {
    if (current.checking || current.state !== 'deciding') return;
    current.checking = true;
    const probe = await call<EvaluateResult>('Runtime.evaluate', {
      expression: PROBE_APP, contextId: current.contextId, returnByValue: true,
    }).then(
      (reply) => parseProbe(reply.result?.value),
      () => undefined,
    );
    current.checking = false;
    if (run !== current || current.state !== 'deciding') return;
    if (probe?.sdk) {
      current.state = 'skipped';
      for (const event of current.held) releaseEvent(event);
      current.held = [];
      return;
    }
    // An SDK starts in the entry file, which a launching app may not have run yet.
    const starting = !probe?.ready && !current.sawRunning && Date.now() - current.startedAt < STARTUP_LIMIT_MS;
    if (starting) {
      current.retry = setTimeout(() => void decide(current), STARTUP_CHECK_MS);
      return;
    }
    current.state = 'streaming';
    current.mmkv = watchMetroMMKV(call, current.contextId);
    current.sockets = watchMetroWebSockets(call, current.contextId, {
      // Metro's own sockets (HMR, inspector), React DevTools and Reactotron. React Native opens some
      // of them with an http:// URL.
      ignoreUrls: [{ source: `^(?:wss?|https?)://[^/]+:(?:${metroPort}|8097|9090)(?:/|$)`, flags: '' }],
      ignoreProtocols: [],
      maxMessage: MAX_SOCKET_MESSAGE,
    });
    current.session = openSession(devsightUrl, sessionInfo(probe?.name), end, (command) => {
      if (command.plugin !== 'storage') return Promise.reject(new Error('This plugin is unavailable through Metro'));
      return readMetroStorage(call, current.contextId, () => run === current, command.method, command.params);
    });
    for (const event of current.held) enqueue(current, event);
    current.held = [];
  };

  const enqueue = (current: Run, event: CdpEvent) => {
    queue = queue.then(() => handle(current, event)).catch(() => {});
  };

  const onEvent = (event: CdpEvent) => {
    switch (event.method) {
      case 'ReactNativeApplication.metadataUpdated':
        metadata = event.params as AppMetadata;
        return;
      case 'Runtime.executionContextCreated':
        startRun((event.params as { context: { id: number } }).context.id);
        return;
      case 'Runtime.executionContextDestroyed':
        if ((event.params as { executionContextId: number }).executionContextId === run?.contextId) void endRun();
        return;
      case 'Runtime.executionContextsCleared':
        void endRun();
        return;
    }
    const relevant =
      event.method === 'Runtime.consoleAPICalled' ||
      event.method === 'Runtime.exceptionThrown' ||
      event.method === 'Runtime.bindingCalled' ||
      event.method.startsWith('Network.');
    const current = run;
    if (!relevant || !current) return;
    if (current.state === 'skipped') {
      releaseEvent(event);
    } else if (current.state === 'deciding') {
      if (current.held.length >= MAX_HELD_EVENTS) releaseEvent(current.held.shift()!);
      current.held.push(event);
      // React Native logs `Running "<app>"` right after the entry file has run.
      if (event.method === 'Runtime.consoleAPICalled' && isRunningLog(event.params as ConsoleCall)) {
        current.sawRunning = true;
        void decide(current);
      }
    } else {
      enqueue(current, event);
    }
  };

  const onMessage = (data: RawData) => {
    let message: CdpReply & { id?: number; method?: string; params?: unknown };
    try {
      message = JSON.parse(data.toString()) as typeof message;
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (typeof message.id === 'number') {
      calls.get(message.id)?.(message);
      calls.delete(message.id);
    } else if (typeof message.method === 'string') {
      onEvent({ method: message.method, params: message.params ?? {} });
    }
  };

  const serializeInApp = async (objects: RemoteObject[], contextId: number): Promise<SerializedValue[]> => {
    const params = {
      executionContextId: contextId,
      functionDeclaration: SERIALIZE_ARGS,
      arguments: objects.map((object) => ({ objectId: object.objectId })),
      returnByValue: true,
    };
    let reply = await call<EvaluateResult>('Runtime.callFunctionOn', params);
    if (reply.result?.value === null) {
      await call('Runtime.evaluate', { expression: INSTALL_SERIALIZER, contextId });
      reply = await call<EvaluateResult>('Runtime.callFunctionOn', params);
    }
    const json = reply.result?.value;
    if (typeof json !== 'string') throw new Error('The app could not serialize the values');
    return JSON.parse(json) as SerializedValue[];
  };

  const serializeArgs = async (args: RemoteObject[], contextId: number): Promise<SerializedValue[]> => {
    const objects = args.filter((arg) => arg.objectId);
    const inApp = objects.length > 0 ? await serializeInApp(objects, contextId).catch(() => undefined) : undefined;
    release(objects);
    let next = 0;
    // Without the in-app values, objects keep the one-line description CDP gave.
    return args.map((arg) => (arg.objectId && inApp ? inApp[next++]! : primitiveValue(arg)));
  };

  const readBody = async (
    requestId: string,
    contentType: string | undefined,
    size: number | undefined,
  ): Promise<BodyPreview | undefined> => {
    if (contentType && /^text\/event-stream/i.test(contentType)) {
      return { kind: 'stream', contentType, summary: 'Event stream' };
    }
    if (!isTextual(contentType)) return { kind: 'binary', contentType, size, summary: contentType ?? 'Binary' };
    if (size !== undefined && size > MAX_BODY_FETCH) {
      return { kind: 'unknown', contentType, size, summary: 'Too large to capture' };
    }
    const result = await call<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId }).catch(
      () => undefined,
    );
    return result ? responseBody(result, contentType) : undefined;
  };

  const handle = async (current: Run, event: CdpEvent) => {
    const session = current.session;
    if (!session || current !== run) {
      releaseEvent(event);
      return;
    }
    switch (event.method) {
      case 'Runtime.consoleAPICalled': {
        const { type, args, executionContextId, timestamp } = event.params as ConsoleCall;
        const level = logLevel(type);
        if (!level) {
          release(args);
          return;
        }
        const values = await serializeArgs(args, executionContextId ?? current.contextId);
        const source = level === 'error' && isUnhandledRejection(values) ? 'unhandledrejection' : 'console';
        session.emit('log', { level, source, args: values }, epochMs(timestamp));
        return;
      }
      case 'Runtime.bindingCalled': {
        const { name, payload } = event.params as { name?: string; payload?: unknown };
        if (name !== WEBSOCKET_BINDING) return;
        const report = parseWebSocketReport(payload);
        if (report) session.emit(report.kind, report.payload as never, report.ts);
        return;
      }
      case 'Runtime.exceptionThrown': {
        const { exceptionDetails: details, timestamp } = event.params as ExceptionThrown;
        const args = details.exception
          ? await serializeArgs([details.exception], details.executionContextId ?? current.contextId)
          : [details.text ?? 'Uncaught exception'];
        session.emit('log', { level: 'error', source: 'uncaught', args }, epochMs(timestamp));
        return;
      }
      case 'Network.requestWillBeSent': {
        const { requestId, request, type, timestamp, wallTime } = event.params as RequestSent;
        // Redirects reuse the id; the first request stands for the chain.
        if (current.requests.has(requestId)) return;
        const ignored = isDevServerRequest(request.url, metroPort);
        current.requests.set(requestId, { start: timestamp, ignored });
        if (ignored) return;
        const headers = request.headers ?? {};
        session.emit(
          'network.request',
          {
            id: requestId,
            initiator: initiatorOf(type),
            method: request.method,
            url: request.url,
            headers,
            body: request.postData ? textBody(request.postData, headerValue(headers, 'content-type')) : undefined,
          },
          wallTime ? Math.round(wallTime * 1000) : undefined,
        );
        return;
      }
      case 'Network.responseReceived': {
        const { requestId, response, timestamp } = event.params as ResponseReceived;
        const request = current.requests.get(requestId);
        if (!request || request.ignored) return;
        request.response = response;
        request.responseAt = timestamp;
        return;
      }
      case 'Network.loadingFinished': {
        const { requestId, timestamp, encodedDataLength } = event.params as LoadingFinished;
        const request = current.requests.get(requestId);
        current.requests.delete(requestId);
        if (!request || request.ignored) return;
        const response = request.response;
        if (!response) {
          session.emit('network.error', {
            id: requestId,
            message: 'The app reported no response',
            duration: elapsed(request.start, timestamp),
          });
          return;
        }
        const headers = response.headers ?? {};
        const contentType = headerValue(headers, 'content-type') || response.mimeType || undefined;
        session.emit('network.response', {
          id: requestId,
          status: response.status,
          statusText: response.statusText || undefined,
          headers,
          body: await readBody(requestId, contentType, encodedDataLength),
          duration: elapsed(request.start, request.responseAt ?? timestamp),
        });
        return;
      }
      case 'Network.loadingFailed': {
        const { requestId, timestamp, errorText, canceled } = event.params as LoadingFailed;
        const request = current.requests.get(requestId);
        current.requests.delete(requestId);
        if (!request || request.ignored) return;
        session.emit('network.error', {
          id: requestId,
          message: errorText || 'Request failed',
          duration: elapsed(request.start, timestamp),
          aborted: canceled || undefined,
        });
        return;
      }
    }
  };

  void (async () => {
    const connected = await connect(target.webSocketDebuggerUrl!, metroPort, controller.signal);
    if (ended) {
      connected?.terminate();
      return;
    }
    if (!connected) {
      // Leaves the target out of the next few scans instead of failing every two seconds.
      retryTimer = setTimeout(end, RETRY_AFTER_FAILURE_MS);
      retryTimer.unref();
      return;
    }
    socket = connected;
    socket.on('message', onMessage);
    socket.on('close', end);
    socket.on('error', () => {});
    // Metadata first, so it is there when the JS context shows up.
    await call('ReactNativeApplication.enable').catch(() => {});
    await call('Runtime.enable').catch(() => {});
    await call('Network.enable').catch(() => {});
  })();

  return { close: end };
}

/** Expo checks the Origin against its own address (127.0.0.1); plain Metro accepts any localhost origin. */
async function connect(url: string, metroPort: number, signal: AbortSignal): Promise<WebSocket | undefined> {
  for (const host of ['127.0.0.1', 'localhost']) {
    if (signal.aborted) return undefined;
    const socket = await openSocket(url, `http://${host}:${metroPort}`, signal);
    if (socket) return socket;
  }
  return undefined;
}

function openSocket(url: string, origin: string, signal: AbortSignal): Promise<WebSocket | undefined> {
  return new Promise((resolve) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, { origin, perMessageDeflate: false, handshakeTimeout: CALL_TIMEOUT_MS });
    } catch {
      resolve(undefined);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = () => {
      signal.removeEventListener('abort', fail);
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.terminate();
      resolve(undefined);
    };
    signal.addEventListener('abort', fail, { once: true });
    socket.once('error', fail);
    socket.once('close', fail);
    socket.once('open', () => {
      timer = setTimeout(() => {
        socket.off('error', fail);
        socket.off('close', fail);
        signal.removeEventListener('abort', fail);
        // Keep an error listener while the awaiting caller takes ownership.
        socket.on('error', () => {});
        resolve(socket);
      }, ORIGIN_CHECK_MS);
    });
  });
}

/** A lost relay ends the watcher; discovery reconnects it and starts a fresh session. */
function openSession(
  url: string,
  info: SessionInfo,
  onDisconnect: () => void,
  onCommand: (command: Extract<ServerToClient, { t: 'command' }>) => Promise<unknown>,
): Session {
  const socket = new WebSocket(url, { handshakeTimeout: CALL_TIMEOUT_MS });
  let seq = 0;
  let ready = false;
  let queued: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const flush = () => {
    timer = undefined;
    if (!ready || queued.length === 0 || socket.readyState !== WebSocket.OPEN) return;
    socket.send(`{"t":"events","events":[${queued.join(',')}]}`);
    queued = [];
  };

  socket.on('open', () => socket.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, session: info })));
  socket.on('message', (data) => {
    let message: ServerToClient;
    try {
      message = JSON.parse(data.toString()) as ServerToClient;
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.t === 'welcome') {
      ready = true;
      flush();
    } else if (message.t === 'command' && socket.readyState === WebSocket.OPEN) {
      const sendResult = (result: object) => {
        if (!closed && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ t: 'result', id: message.id, ...result }));
        }
      };
      void onCommand(message).then(
        (result) => sendResult({ ok: true, result }),
        (error: unknown) => sendResult({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    } else if (message.t === 'reject') {
      socket.close();
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    if (!closed) onDisconnect();
  });

  return {
    emit(kind, payload, ts = Date.now()) {
      if (closed) return;
      if (queued.length >= MAX_HELD_EVENTS) queued.shift();
      queued.push(JSON.stringify({ seq: ++seq, ts, kind, payload }));
      if (ready && !timer) timer = setTimeout(flush, 20);
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      flush();
      queued = [];
      socket.close();
    },
  };
}

function isRunningLog(event: ConsoleCall): boolean {
  const first = event.args[0]?.value;
  return typeof first === 'string' && first.startsWith('Running "');
}

function parseProbe(value: unknown): { sdk: boolean; ready: boolean; name: string | null } | undefined {
  try {
    return typeof value === 'string' ? (JSON.parse(value) as { sdk: boolean; ready: boolean; name: string | null }) : undefined;
  } catch {
    return undefined;
  }
}

/** CDP console and exception timestamps are milliseconds since the epoch. */
function epochMs(timestamp: number | undefined): number {
  return typeof timestamp === 'number' && timestamp > 1e12 ? Math.round(timestamp) : Date.now();
}

/** Network timestamps are in seconds. */
function elapsed(start: number, end: number): number {
  return Math.max(0, Math.round((end - start) * 1000));
}
