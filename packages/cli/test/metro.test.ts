import http from 'node:http';
import { createContext, runInContext } from 'node:vm';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { startMetroBridge, type MetroBridge } from '../src/metro.js';
import { createServer, type CapybaraServer } from '../src/server.js';

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const until = (assertion: () => void) => vi.waitFor(assertion, { timeout: 4_000, interval: 10 });

type Command = { id: number; method: string; params: Record<string, any> };

async function fixture(options: {
  sdk?: boolean;
  ready?: boolean;
  multiple?: boolean;
  fallbackOrigin?: boolean;
  /** Listed and described as Expo Go on an Android emulator. */
  expoGo?: boolean;
  /** The answer to every `Runtime.evaluate`. */
  evaluateError?: { code: number; message: string };
} = {}) {
  const metro = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(visible ? [null, { id: 'invalid' }, {
      id: 'app',
      title: 'Hermes app',
      appId: options.expoGo ? 'host.exp.exponent' : undefined,
      webSocketDebuggerUrl: `ws://localhost:${metroPort}/inspector/debug`,
      reactNative: { capabilities: { supportsMultipleDebuggers: options.multiple ?? true } },
    }] : []));
  });
  const wss = new WebSocketServer({ server: metro });
  await new Promise<void>((resolve, reject) => {
    metro.once('error', reject);
    metro.listen(0, 'localhost', resolve);
  });
  const metroPort = (metro.address() as AddressInfo).port;
  cleanups.push(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => metro.close(() => resolve()));
  });

  let visible = true;
  let sdk = options.sdk ?? false;
  let heldProbes: Array<() => void> | null = null;
  const ready = options.ready ?? true;
  let socket: WebSocket | undefined;
  let connections = 0;
  let contextId = 1;
  const commands: Command[] = [];
  const origins: string[] = [];
  const bodies = new Map<string, { body: string; base64Encoded: boolean }>();
  const runtimeTimers = new Set<ReturnType<typeof setInterval>>();
  const vm = createContext({
    setInterval: (fn: () => void, delay: number) => {
      const timer = setInterval(fn, delay);
      timer.unref();
      runtimeTimers.add(timer);
      return timer;
    },
    clearInterval: (timer: ReturnType<typeof setInterval>) => { clearInterval(timer); runtimeTimers.delete(timer); },
  });
  cleanups.push(() => { for (const timer of runtimeTimers) clearInterval(timer); });
  const handles = new Map<string, unknown>();
  const bindings = new Set<string>();
  let nextHandle = 0;
  // These values originate in a different JS runtime, like Hermes RemoteObjects.
  runInContext(`globalThis.objects = {
    user: { name: 'Ada', roles: ['admin'] },
    error: new Error('Uncaught (in promise, id: 0) failed'),
    nullObject: null
  };
  globalThis.saved = { user: '{"name":"Ada"}' };
  globalThis.modules = new Map([[1, {
    isInitialized: true, publicModule: { exports: { default: {
      getAllKeys: async () => Object.keys(saved), getItem: async (key) => saved[key] ?? null,
      setItem: async (key, value) => { saved[key] = value; }, removeItem: async (key) => { delete saved[key]; },
      clear: async () => { saved = {}; }
    } } }
  }]]);
  globalThis.__r = { getModules: () => modules }`, vm);
  const event = (method: string, params: unknown) => socket?.send(JSON.stringify({ method, params }));
  const reply = (ws: WebSocket, id: number, result: unknown) => ws.send(JSON.stringify({ id, result }));

  wss.on('connection', (ws, req) => {
    origins.push(req.headers.origin ?? '');
    if (options.fallbackOrigin && req.headers.origin?.includes('127.0.0.1')) {
      ws.close();
      return;
    }
    socket = ws;
    connections++;
    ws.on('error', () => {});
    ws.on('message', (data) => {
      const command = JSON.parse(data.toString()) as Command;
      commands.push(command);
      const { id, method, params } = command;
      if (method === 'ReactNativeApplication.enable') {
        event('ReactNativeApplication.metadataUpdated', options.expoGo
          ? { appDisplayName: 'Expo Go', platform: 'android', deviceName: 'Google sdk_gphone64_arm64', reactNativeVersion: '0.86.2' }
          : { platform: 'ios', deviceName: 'iPhone simulator', reactNativeVersion: '0.86.3' });
      } else if (method === 'Runtime.enable') {
        event('Runtime.executionContextCreated', { context: { id: contextId } });
      } else if (method === 'Runtime.evaluate') {
        if (options.evaluateError) {
          ws.send(JSON.stringify({ id, error: options.evaluateError }));
        } else if (params.expression.includes('__CAPYBARA_CLIENT__')) {
          // Read now, as the app would, even when the answer is held back.
          const value = JSON.stringify({ sdk, ready, name: 'No SDK app' });
          if (heldProbes) heldProbes.push(() => reply(ws, id, { result: { value } }));
          else reply(ws, id, { result: { value } });
        } else {
          const value = runInContext(params.expression, vm);
          if (params.returnByValue === false) {
            const objectId = `handle-${++nextHandle}`;
            handles.set(objectId, value);
            reply(ws, id, { result: { type: 'object', objectId } });
          } else reply(ws, id, { result: { value } });
        }
        return;
      } else if (method === 'Runtime.callFunctionOn') {
        if (params.objectId) {
          vm.receiver = handles.get(params.objectId);
          reply(ws, id, { result: { value: runInContext(`(${params.functionDeclaration}).call(receiver)`, vm) } });
          return;
        }
        vm.handles = params.arguments.map((arg: { objectId: string }) => arg.objectId);
        const value = runInContext(`(${params.functionDeclaration}).apply(null, handles.map(id => objects[id]))`, vm);
        reply(ws, id, { result: { value } });
        return;
      } else if (method === 'Network.getResponseBody') {
        const body = bodies.get(params.requestId);
        if (body) reply(ws, id, body);
        else ws.send(JSON.stringify({ id, error: { message: 'Body evicted' } }));
        return;
      } else if (method === 'Runtime.releaseObject') {
        handles.delete(params.objectId);
      } else if (method === 'Runtime.addBinding') {
        // Like React Native: a runtime function whose calls reach subscribed sessions as events.
        bindings.add(params.name);
        (vm as Record<string, unknown>)[params.name] = (payload: string) => {
          if (bindings.has(params.name)) event('Runtime.bindingCalled', { name: params.name, payload, executionContextId: contextId });
        };
      } else if (method === 'Runtime.removeBinding') {
        bindings.delete(params.name);
      }
      reply(ws, id, {});
    });
  });

  let server: CapybaraServer = createServer({ port: 0, host: '127.0.0.1' });
  const { port } = await server.start();
  cleanups.push(() => server.close());
  const messages: any[] = [];
  const viewers: WebSocket[] = [];
  const view = async () => {
    const viewer = new WebSocket(`ws://127.0.0.1:${port}/viewer`, { origin: `http://127.0.0.1:${port}` });
    viewers.push(viewer);
    viewer.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      viewer.once('open', resolve);
      viewer.once('error', reject);
    });
    return viewer;
  };
  const viewer = await view();
  cleanups.push(() => {
    for (const ws of viewers) ws.terminate();
  });
  let bridge: MetroBridge | undefined;
  cleanups.push(() => bridge?.stop());
  const hints: string[] = [];

  return {
    messages, commands, bodies, origins, viewer, event, hints,
    run: (code: string) => runInContext(code, vm),
    events: () => messages.filter((m) => m.t === 'events').flatMap((m) => m.events),
    sessions: () => messages.filter((m) => m.t === 'session' && m.session.connected),
    connections: () => connections,
    start: () => {
      bridge = startMetroBridge({ port, metroPorts: [metroPort], pollInterval: 25, version: 'test', onHint: (hint) => hints.push(hint) });
    },
    stop: () => bridge?.stop(),
    setSdk: (value: boolean) => { sdk = value; },
    probes: () => commands.filter((c) => c.method === 'Runtime.evaluate' && c.params.expression.includes('__CAPYBARA_CLIENT__')).length,
    holdProbes: () => { heldProbes = []; },
    releaseProbes: () => {
      const held = heldProbes ?? [];
      heldProbes = null;
      for (const send of held) send();
    },
    setVisible: (value: boolean) => { visible = value; },
    disconnect: () => socket?.terminate(),
    reload: () => {
      event('Runtime.executionContextsCleared', {});
      event('Runtime.executionContextCreated', { context: { id: ++contextId } });
    },
    restartServer: async () => {
      await server.close();
      server = createServer({ port, host: '127.0.0.1' });
      await server.start();
      await view();
    },
    log: (args: unknown[], type = 'log') => event('Runtime.consoleAPICalled', {
      type, args, executionContextId: contextId, timestamp: 1_800_000_000_000,
    }),
    request: (id: string, url = 'https://api.example.test/users', postData?: string, params: Record<string, unknown> = {}) => event('Network.requestWillBeSent', {
      requestId: id, timestamp: 10, wallTime: 1_800_000_000, type: 'Fetch',
      request: { url, method: postData ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, postData },
      ...params,
    }),
    finish: (id: string, status = 200, mimeType = 'application/json', size = 32) => {
      event('Network.responseReceived', {
        requestId: id, timestamp: 10.125,
        response: { status, statusText: status === 404 ? 'Not Found' : 'OK', mimeType, headers: { 'X-Response': 'yes' } },
      });
      event('Network.loadingFinished', { requestId: id, timestamp: 10.5, encodedDataLength: size });
    },
    metroPort,
  };
}

describe('Metro discovery and CDP event relay', () => {
  it('discovers a private MMKV instance through CDP and restores hooks before disconnecting', async () => {
    const f = await fixture();
    f.run(`
      class MMKV {
        getFunctionFromCache() { return () => 'private value'; }
        getString(key) { return this.getFunctionFromCache()(key); }
        getNumber() {} getBoolean() {} set() { throw new Error('Unexpected write'); }
        getAllKeys() { return ['user']; }
      }
      const originalMMKV = MMKV.prototype.getFunctionFromCache;
      const privateRead = (() => { const storage = new MMKV(); return () => storage.getString('user'); })();
      modules.set(2, { isInitialized: true, verboseName: '/node_modules/react-native-mmkv/src/MMKV.ts', publicModule: { exports: { MMKV } } });
    `);
    f.start();
    await until(() => expect(f.sessions()).toHaveLength(1));
    expect(f.run('privateRead()')).toBe('private value');
    const sessionId = f.sessions()[0].session.info.id;
    f.viewer.send(JSON.stringify({ t: 'command', id: 'private-list', sessionId, plugin: 'storage', method: 'list' }));
    await until(() => expect(f.messages.find(m => m.id === 'private-list')).toBeDefined());
    const result = f.messages.find(m => m.id === 'private-list');
    expect(result.ok).toBe(true);
    expect(result.result.some((item: any) => item.id.startsWith('mmkv-runtime:'))).toBe(true);
    f.stop();
    await until(() => expect(f.run('MMKV.prototype.getFunctionFromCache === originalMMKV')).toBe(true));
    expect(f.run('globalThis.__CAPYBARA_MMKV_TRACKER_V1__')).toBeUndefined();
  });

  it('discovers a late app and serializes console objects, primitives, rejections and exceptions without an SDK', async () => {
    const f = await fixture();
    f.setVisible(false);
    f.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(f.connections()).toBe(0);
    f.setVisible(true);
    await until(() => expect(f.sessions()).toHaveLength(1));
    expect(f.sessions()[0].session.info).toMatchObject({
      appName: 'No SDK app', platform: 'ios', sdk: { name: 'metro', version: 'test' },
    });
    f.log([{ type: 'string', value: 'hello' }, { type: 'object', objectId: 'user' }, { type: 'number', unserializableValue: 'NaN' }]);
    f.log([{ type: 'object', objectId: 'error' }], 'error');
    f.log([{ type: 'object', objectId: 'nullObject' }]);
    f.event('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught exception' } });
    await until(() => expect(f.events()).toHaveLength(4));
    expect(f.events()[0]).toMatchObject({ ts: 1_800_000_000_000, payload: {
      level: 'log', args: ['hello', { name: 'Ada', roles: ['admin'] }, { $t: 'number', v: 'NaN' }],
    } });
    expect(f.events()[1].payload).toMatchObject({ level: 'error', source: 'unhandledrejection' });
    expect(f.events()[2].payload.args).toEqual([null]);
    expect(f.events()[3].payload).toMatchObject({ level: 'error', source: 'uncaught' });
    expect(f.commands.filter((c) => c.method === 'Runtime.releaseObject')).toHaveLength(3);
    expect(f.commands.find((c) => c.method === 'Runtime.evaluate' && c.params.expression.includes('__CAPYBARA_SERIALIZE__'))?.params.contextId).toBe(1);
    expect(f.events().map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('keeps console groups, tables and traces apart from plain logs', async () => {
    const f = await fixture();
    f.start();
    await until(() => expect(f.sessions()).toHaveLength(1));
    f.log([{ type: 'string', value: 'Loading' }], 'startGroup');
    f.log([{ type: 'string', value: 'inside' }]);
    f.log([], 'startGroupCollapsed');
    f.log([{ type: 'object', objectId: 'user' }], 'table');
    f.log([], 'endGroup');
    f.log([], 'endGroup');
    f.log([{ type: 'string', value: 'outside' }]);
    f.event('Runtime.consoleAPICalled', {
      type: 'trace', args: [], executionContextId: 1, timestamp: 1_800_000_000_000,
      stackTrace: { callFrames: [{ functionName: 'load', url: 'http://localhost:8081/index.bundle', lineNumber: 9, columnNumber: 4 }] },
    });
    await until(() => expect(f.events()).toHaveLength(6));
    expect(f.events().map((e) => e.payload)).toEqual([
      { level: 'log', source: 'console', args: ['Loading'], method: 'group' },
      { level: 'log', source: 'console', args: ['inside'], depth: 1 },
      { level: 'log', source: 'console', args: ['console.groupCollapsed'], depth: 1, method: 'groupCollapsed' },
      { level: 'log', source: 'console', args: [{ name: 'Ada', roles: ['admin'] }], depth: 2, method: 'table' },
      { level: 'log', source: 'console', args: ['outside'] },
      {
        level: 'log',
        source: 'console',
        args: ['console.trace', { $t: 'error', name: 'Trace', message: '', stack: 'Trace\n    at load (http://localhost:8081/index.bundle:10:5)' }],
        method: 'trace',
      },
    ]);
  });

  it('shows the headers of a response whose body is still arriving', async () => {
    const f = await fixture();
    f.start();
    await until(() => expect(f.sessions()).toHaveLength(1));
    f.request('s1', 'https://api.example.test/chat');
    f.event('Network.responseReceived', {
      requestId: 's1', timestamp: 10.125, response: { status: 200, statusText: 'OK', mimeType: 'application/x-ndjson', headers: { 'Content-Type': 'application/x-ndjson' } },
    });
    await until(() => expect(f.events()).toHaveLength(2));
    expect(f.events()[1].payload).toEqual({
      id: 's1', status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/x-ndjson' }, duration: 125, streaming: true,
    });
    f.event('Network.loadingFinished', { requestId: 's1', timestamp: 12, encodedDataLength: 20 });
    await until(() => expect(f.events()).toHaveLength(3));
    expect(f.events()[2].payload).toMatchObject({ id: 's1', status: 200, duration: 125 });
    expect(f.events()[2].payload.streaming).toBeUndefined();
  });

  it('captures POST headers/body, 404 responses, base64 bodies, failed and aborted requests', async () => {
    const f = await fixture();
    f.start();
    await until(() => expect(f.sessions()).toHaveLength(1));
    f.bodies.set('post', { body: Buffer.from('{"error":"missing"}').toString('base64'), base64Encoded: true });
    f.request('post', undefined, '{"name":"Ada"}');
    f.finish('post', 404);
    f.request('fail');
    f.event('Network.loadingFailed', { requestId: 'fail', timestamp: 10.2, errorText: 'Connection refused' });
    f.request('abort');
    f.event('Network.loadingFailed', { requestId: 'abort', timestamp: 10.3, canceled: true });
    await until(() => expect(f.events()).toHaveLength(6));
    expect(f.events()[0].payload).toMatchObject({ method: 'POST', initiator: 'fetch', headers: { 'Content-Type': 'application/json' }, body: { text: '{"name":"Ada"}' } });
    expect(f.events()[1].payload).toMatchObject({ status: 404, duration: 125, headers: { 'X-Response': 'yes' }, body: { text: '{"error":"missing"}' } });
    expect(f.events()[3]).toMatchObject({ kind: 'network.error', payload: { message: 'Connection refused', duration: 200 } });
    expect(f.events()[5].payload).toMatchObject({ aborted: true, duration: 300 });
  });

  it('tells fetch from XHR by the JS stack React Native sends', async () => {
    const f = await fixture();
    f.start();
    await until(() => expect(f.sessions()).toHaveLength(1));
    // React Native sends no type, but the stack of the request; whatwg-fetch sends its XHR from inside fetch().
    const stack = (...names: string[]) => ({
      type: 'script',
      stack: { callFrames: names.map((functionName) => ({ functionName, url: 'http://localhost:8081/index.bundle', lineNumber: 1, columnNumber: 1 })) },
    });
    f.request('rn-fetch', undefined, undefined, { type: undefined, initiator: stack('sendRequest', 'send', 'anonymous', 'Promise', 'fetch', 'onPress') });
    f.request('rn-xhr', undefined, undefined, { type: undefined, initiator: stack('sendRequest', 'send', 'dispatchXhrRequest', 'xhrAdapter') });
    // Expo Go's network inspector reports fetch and XHR alike: type "Other", no stack.
    f.request('expo', undefined, undefined, { type: 'Other', initiator: { type: 'script' } });
    await until(() => expect(f.events()).toHaveLength(3));
    expect(f.events().map((e) => [e.payload.id, e.payload.initiator])).toEqual([
      ['rn-fetch', 'fetch'],
      ['rn-xhr', 'xhr'],
      ['expo', 'other'],
    ]);
  });

  it('skips binary/oversized body downloads and keeps the status when a body is unavailable', async () => {
    const f = await fixture();
    f.start();
    await until(() => expect(f.sessions()).toHaveLength(1));
    f.request('binary'); f.finish('binary', 200, 'image/png');
    f.request('large'); f.finish('large', 200, 'text/plain', 5 * 1024 * 1024);
    f.request('gone'); f.finish('gone');
    f.request('metro', `http://localhost:${f.metroPort}/symbolicate`); f.finish('metro');
    await until(() => expect(f.events()).toHaveLength(6));
    expect(f.events()[1].payload.body).toMatchObject({ kind: 'binary' });
    expect(f.events()[3].payload.body).toMatchObject({ kind: 'unknown', summary: 'Too large to capture' });
    expect(f.events()[5].payload).toMatchObject({ status: 200 });
    expect(f.events()[5].payload.body).toBeUndefined();
    expect(f.commands.filter((c) => c.method === 'Network.getResponseBody').map((c) => c.params.requestId)).toEqual(['gone']);
  });

  it('holds startup events until SDK detection and skips an SDK app without duplicate sessions', async () => {
    const f = await fixture({ ready: false });
    f.start();
    await until(() => expect(f.commands.some((c) => c.method === 'Network.enable')).toBe(true));
    f.log([{ type: 'object', objectId: 'user' }]);
    f.setSdk(true);
    f.log([{ type: 'string', value: 'Running "App"' }]);
    await until(() => expect(f.commands.some((c) => c.method === 'Runtime.releaseObject')).toBe(true));
    expect(f.sessions()).toHaveLength(0);
    expect(f.events()).toHaveLength(0);
  });

  it('says when it started reading an app that was already running, and not when it saw the app start', async () => {
    const running = await fixture();
    running.start();
    await until(() => expect(running.sessions()).toHaveLength(1));
    expect(running.sessions()[0].session.info.attachedLate).toBe(true);
    running.stop();

    const starting = await fixture({ ready: false });
    starting.start();
    await until(() => expect(starting.commands.some((c) => c.method === 'Network.enable')).toBe(true));
    starting.log([{ type: 'string', value: 'Running "App"' }]);
    await until(() => expect(starting.sessions()).toHaveLength(1));
    expect(starting.sessions()[0].session.info).not.toHaveProperty('attachedLate');
  });

  it('checks again when the app starts while an earlier check is still unanswered', async () => {
    const f = await fixture({ ready: false });
    f.holdProbes();
    f.start();
    await until(() => expect(f.probes()).toBe(1));
    f.log([{ type: 'object', objectId: 'user' }]);
    f.setSdk(true);
    f.log([{ type: 'string', value: 'Running "App"' }]);
    // Sent after the log on the same socket, so the bridge sees the app start before this stale answer.
    f.releaseProbes();
    await until(() => expect(f.commands.some((c) => c.method === 'Runtime.releaseObject')).toBe(true));
    expect(f.probes()).toBe(2);
    expect(f.sessions()).toHaveLength(0);
    expect(f.events()).toHaveLength(0);
  });

  it('opens no session for an engine that cannot evaluate, as Expo Go on Android, and says so once', async () => {
    // What Expo Go 57.0.9 on Android answers, with or without the SDK in the app.
    const f = await fixture({ expoGo: true, evaluateError: { code: -32601, message: 'Runtime.evaluate' } });
    f.start();
    await until(() => expect(f.hints).toHaveLength(1));
    expect(f.hints[0]).toBe(
      "Expo Go on Android (Google sdk_gphone64_arm64) can't be read through Metro: its JavaScript engine does not support debugging. " +
        'Capybara shows it only when the app runs the SDK (@capybara-devtools/react-native), or as a development build.',
    );
    f.log([{ type: 'string', value: 'Running "main"' }]);
    // Expo's inspector proxy also sends this target the requests of other apps.
    f.request('other-app'); f.finish('other-app');
    f.reload();
    await until(() => expect(f.probes()).toBe(2));
    f.disconnect();
    await until(() => expect(f.probes()).toBe(3));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(f.hints).toHaveLength(1);
    expect(f.messages.filter((m) => m.t === 'session')).toHaveLength(0);
  });

  it('keeps checking an app whose check fails for another reason, and reads it once it has started', async () => {
    const f = await fixture({ evaluateError: { code: -32000, message: 'Execution context was destroyed' } });
    f.start();
    await until(() => expect(f.probes()).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(f.sessions()).toHaveLength(0);
    f.log([{ type: 'string', value: 'Running "App"' }]);
    await until(() => expect(f.sessions()).toHaveLength(1));
    expect(f.hints).toHaveLength(0);
  });

  it('starts a new session after reload and allows request IDs to be reused', async () => {
    const f = await fixture();
    f.start();
    await until(() => expect(f.sessions()).toHaveLength(1));
    f.request('same'); f.finish('same');
    await until(() => expect(f.events()).toHaveLength(2));
    f.reload();
    await until(() => expect(f.sessions()).toHaveLength(2));
    const ids = f.sessions().map((m) => m.session.info.id);
    expect(ids[0]).not.toBe(ids[1]);
    await until(() => expect(f.messages.some((m) => m.t === 'session' && m.session.info.id === ids[0] && !m.session.connected)).toBe(true));
    f.request('same'); f.finish('same');
    await until(() => expect(f.events()).toHaveLength(4));
    expect(f.events().map((e) => e.seq)).toEqual([1, 2, 1, 2]);
  });

  it('rediscovers a disconnected Metro target and reconnects after the relay server restarts', async () => {
    const f = await fixture();
    f.start();
    await until(() => expect(f.sessions()).toHaveLength(1));
    f.disconnect();
    await until(() => expect(f.sessions()).toHaveLength(2));
    await f.restartServer();
    await until(() => expect(f.sessions()).toHaveLength(3));
    f.log([{ type: 'string', value: 'after reconnect' }]);
    await until(() => expect(f.events().at(-1)?.payload.args).toEqual(['after reconnect']));
    f.stop();
    const connections = f.connections();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(f.connections()).toBe(connections);
    expect(f.messages.at(-1)).toMatchObject({ t: 'session', session: { connected: false } });
  });

  it('does not attach to targets that would disconnect another debugger', async () => {
    const f = await fixture({ multiple: false });
    f.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(f.connections()).toBe(0);
    expect(f.sessions()).toHaveLength(0);
  });

  it('cancels a connection stopped before CDP initialization without creating a ghost session', async () => {
    const f = await fixture();
    f.start();
    await until(() => expect(f.connections()).toBe(1));
    f.stop();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(f.commands).toHaveLength(0);
    expect(f.sessions()).toHaveLength(0);
    expect(f.connections()).toBe(1);
  });

  it('tries the alternative localhost Origin after Expo rejects the first socket', async () => {
    const f = await fixture({ fallbackOrigin: true });
    f.start();
    await until(() => expect(f.sessions()).toHaveLength(1));
    expect(f.origins).toEqual([`http://127.0.0.1:${f.metroPort}`, `http://localhost:${f.metroPort}`]);
    f.viewer.send(JSON.stringify({ t: 'command', id: 'storage', sessionId: f.sessions()[0].session.info.id, plugin: 'storage', method: 'clear' }));
    await until(() => expect(f.messages.find((m) => m.t === 'result')).toMatchObject({ ok: false, error: 'Invalid storage command' }));
  });

  it('relays WebSocket traffic, including a socket opened before attaching, then removes the hook', async () => {
    const f = await fixture();
    // React Native's WebSocket dispatches its events from JS.
    f.run(`
      globalThis.navigator = { product: 'ReactNative' };
      class Target {
        constructor() { this.listeners = {}; }
        addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
        dispatchEvent(event) { for (const fn of this.listeners[event.type] ?? []) fn(event); return true; }
      }
      class WebSocket extends Target {
        constructor(url, protocols) { super(); this.url = url; this.readyState = 0; this.protocol = ''; }
        send(data) { this.last = data; }
        deliver(type, init) { if (type === 'open') this.readyState = 1; this.dispatchEvent({ type, ...init }); }
      }
      globalThis.WebSocket = WebSocket;
      globalThis.early = new WebSocket('wss://chat.example.test/early');
      early.deliver('open');
    `);
    f.start();
    await until(() => expect(f.run('typeof __CAPYBARA_WS_TRACKER_V1__')).toBe('object'));
    expect(f.commands.find((c) => c.method === 'Runtime.addBinding')?.params).toEqual({
      name: '__capybaraWebSocket', executionContextId: 1,
    });

    f.run(`
      early.deliver('message', { data: 'from before' });
      // The class name above is a script-scoped binding; the app's global is the patched constructor.
      const live = new globalThis.WebSocket('wss://chat.example.test/live', 'v1');
      live.deliver('open');
      live.send('ping');
      live.deliver('message', { data: '{"pong":true}' });
      live.deliver('close', { code: 1000, reason: 'done' });
      new WebSocket('ws://localhost:${f.metroPort}/hot').deliver('open');
    `);
    await until(() => expect(f.events().some((e) => e.kind === 'ws.close')).toBe(true));
    const sockets = f.events().filter((e) => e.kind.startsWith('ws.'));
    expect(sockets.map((e) => [e.kind, e.payload.url ?? e.payload.direction ?? e.payload.code ?? ''])).toEqual([
      ['ws.connect', 'wss://chat.example.test/early'],
      ['ws.open', ''],
      ['ws.message', 'received'],
      ['ws.connect', 'wss://chat.example.test/live'],
      ['ws.open', ''],
      ['ws.message', 'sent'],
      ['ws.message', 'received'],
      ['ws.close', 1000],
    ]);
    expect(sockets[0].payload.existing).toBe(true);
    expect(sockets[3].payload).toMatchObject({ protocols: ['v1'] });
    expect(sockets[3].payload.existing).toBeUndefined();
    expect(sockets[6].payload.data).toMatchObject({ kind: 'text', text: '{"pong":true}', size: 13 });

    f.stop();
    await until(() => expect(f.run('typeof __CAPYBARA_WS_TRACKER_V1__')).toBe('undefined'));
    expect(f.run('Object.prototype.hasOwnProperty.call(WebSocket.prototype, "dispatchEvent")')).toBe(false);
    expect(f.run('globalThis.WebSocket === WebSocket')).toBe(true);
    // Sent once the app has answered the stop evaluation.
    await until(() => expect(f.commands.some((c) => c.method === 'Runtime.removeBinding')).toBe(true));
  });

  it('routes storage commands from the viewer to the app through CDP, writes included', async () => {
    const f = await fixture();
    f.start();
    await until(() => expect(f.sessions()).toHaveLength(1));
    const command = (id: string, method: string, params?: unknown) => f.viewer.send(JSON.stringify({
      t: 'command', id, sessionId: f.sessions()[0].session.info.id, plugin: 'storage', method, params,
    }));
    const result = (id: string) => f.messages.find((m) => m.t === 'result' && m.id === id);
    command('list', 'list');
    await until(() => expect(result('list')).toMatchObject({ ok: true, result: [{ readOnly: false, canClear: true }] }));
    const adapter = result('list').result[0].id;
    command('entries', 'entries', { adapter });
    await until(() => expect(result('entries')).toMatchObject({ ok: true, result: { total: 1, entries: [{ key: 'user', value: '{"name":"Ada"}' }] } }));
    command('get', 'get', { adapter, key: 'user' });
    await until(() => expect(result('get')).toMatchObject({ ok: true, result: { value: '{"name":"Ada"}' } }));
    command('write', 'set', { adapter, key: 'user', value: 'changed' });
    await until(() => expect(result('write')).toMatchObject({ ok: true, result: null }));
    command('reread', 'get', { adapter, key: 'user' });
    await until(() => expect(result('reread')).toMatchObject({ ok: true, result: { value: 'changed' } }));
    command('remove', 'remove', { adapter, key: 'user' });
    await until(() => expect(result('remove')).toMatchObject({ ok: true, result: null }));
    command('empty', 'entries', { adapter });
    await until(() => expect(result('empty')).toMatchObject({ ok: true, result: { total: 0, entries: [] } }));
    expect(f.commands.filter((c) => c.method === 'Runtime.releaseObject')).toHaveLength(7);
  });
});
