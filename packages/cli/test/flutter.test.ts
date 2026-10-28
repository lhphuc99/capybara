import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { isLoopbackVmUri, parseDdsProcess, redactVmUri, resolveDds } from '../src/flutter-discovery.js';
import { createPrintReader, flutterErrorPayload, logRecordLevel } from '../src/flutter-events.js';
import { startFlutterBridge, type FlutterBridge } from '../src/flutter.js';
import { createServer } from '../src/server.js';
import { fakeVmService, TOKEN } from './fake-vm-service.js';

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const until = (assertion: () => void) => vi.waitFor(assertion, { timeout: 4_000, interval: 10 });

async function fixture(options: Parameters<typeof fakeVmService>[0] & { scan?: boolean } = {}) {
  const vm = await fakeVmService(options);
  cleanups.push(() => vm.close());
  const server = createServer({ port: 0, host: '127.0.0.1' });
  const { port } = await server.start();
  cleanups.push(() => server.close());
  const messages: any[] = [];
  const viewer = new WebSocket(`ws://127.0.0.1:${port}/viewer`, { origin: `http://127.0.0.1:${port}` });
  viewer.on('message', (data) => messages.push(JSON.parse(data.toString())));
  await new Promise((resolve) => viewer.once('open', resolve));
  cleanups.push(() => viewer.terminate());
  const hints: string[] = [];
  let bridge: FlutterBridge | undefined;
  cleanups.push(() => bridge?.stop());
  const start = (extra: Partial<Parameters<typeof startFlutterBridge>[0]> = {}) => {
    bridge = startFlutterBridge({
      port,
      version: 'test',
      pollInterval: 25,
      httpInterval: 25,
      listProcesses: async () => (options.scan === false ? [] : ['  1 /bin/zsh', vm.psLine]),
      onHint: (hint) => hints.push(hint),
      ...extra,
    });
    server.setFlutterAttach(bridge.attach);
    return bridge;
  };
  return {
    vm,
    server,
    port,
    viewer,
    hints,
    messages,
    start,
    stop: () => bridge?.stop(),
    // The latest state of each session.
    sessions: () => [...new Map(messages.filter((m) => m.t === 'session').map((m) => [m.session.info.id, m.session])).values()],
    serverInfo: () => [...messages].reverse().find((m) => m.t === 'server' || m.t === 'init')?.server,
    events: (kind?: string) =>
      messages.filter((m) => m.t === 'events').flatMap((m) => m.events).filter((e: any) => !kind || e.kind === kind),
  };
}

const errorNode = (summary: string, frames: string[]) => ({
  type: '_FlutterErrorDetailsNode',
  description: 'Exception caught by widgets library',
  errorsSinceReload: 1,
  renderedErrorText: `Another exception was thrown: ${summary}`,
  properties: [
    { type: 'ErrorDescription', description: 'The following StateError was thrown building Cart(dirty):' },
    { type: 'ErrorSummary', description: summary, level: 'summary' },
    { type: 'ErrorSpacer', description: '' },
    {
      type: 'DiagnosticsBlock',
      name: 'The relevant error-causing widget was',
      children: [{ type: 'ErrorDescription', description: 'Cart Cart:file:///Users/me/shop/lib/cart.dart:12:5' }],
    },
    {
      type: 'DiagnosticsStackTrace',
      name: 'When the exception was thrown, this was the stack',
      children: frames.map((description) => ({ type: 'DiagnosticsProperty<void>', description })),
    },
  ],
});

describe('Flutter apps through the Dart VM service', () => {
  it('finds an app started by flutter run and reports it as a session', async () => {
    const t = await fixture();
    t.start();
    await until(() => expect(t.sessions().filter((s) => s.connected)).toHaveLength(1));
    expect(t.sessions()[0].info).toMatchObject({
      appName: 'shop',
      platform: 'ios',
      sdk: { name: 'dart-vm-service', version: 'test' },
      device: { model: 'iPhone Duo' },
      runtime: 'Flutter 3.47.8 · Dart 3.13.7 · via Dart VM service',
      dartPackages: { app: ['shop'], dirs: { shop: '/Users/me/shop/lib/' } },
    });
    expect(t.sessions()[0].info.plugins).toBeUndefined();
    expect(t.vm.calls.find((call) => call.method === 'setClientName')?.params).toEqual({ name: 'Capybara' });
  });

  it('only reads, and turns on nothing but HTTP profiling', async () => {
    const t = await fixture();
    t.start();
    await until(() => expect(t.vm.httpOn()).toBe(true));
    t.vm.print('hello');
    await until(() => expect(t.events('log')).toHaveLength(1));
    const allowed = new Set([
      'setClientName', 'streamListen', 'getVM', 'getIsolate', 'getObject', 'lookupResolvedPackageUris', 's1.flutterVersion',
      'ext.dart.io.httpEnableTimelineLogging', 'ext.dart.io.getHttpProfile', 'ext.dart.io.getHttpProfileRequest',
    ]);
    expect(t.vm.calls.map((call) => call.method).filter((method) => !allowed.has(method))).toEqual([]);
  });

  it('makes one entry of each print, without Flutter’s tag, keeping several lines together', async () => {
    const t = await fixture();
    t.start();
    await until(() => expect(t.sessions()).toHaveLength(1));
    t.vm.print('one');
    t.vm.print('two\nlines');
    t.vm.print('oops', 'Stderr');
    await until(() => expect(t.events('log')).toHaveLength(3));
    expect(t.events('log').map((e: any) => [e.payload.level, e.payload.args])).toEqual([
      ['log', ['one']],
      ['log', ['two\nlines']],
      ['error', ['oops']],
    ]);
  });

  it('keeps the logs the app wrote before Capybara attached, which DDS replays', async () => {
    const t = await fixture({ age: 60_000 });
    t.vm.print('before');
    t.start();
    await until(() => expect(t.events('log').map((e: any) => e.payload.args[0])).toEqual(['before']));
    // HTTP profiling was off, so requests from before are missing.
    expect(t.sessions()[0].info.attachedLate).toBe(true);
  });

  it('puts the replayed history of different streams in the order the app wrote it', async () => {
    const t = await fixture({ age: 60_000 });
    const at = Date.now() - 10_000;
    t.vm.emit('Logging', { kind: 'Logging', timestamp: at + 2, logRecord: { level: 0, message: { kind: 'String', valueAsString: 'second' } } });
    t.vm.emit('Stdout', { kind: 'WriteEvent', timestamp: at + 1, bytes: Buffer.from('flutter: first').toString('base64') });
    t.vm.emit('Stdout', { kind: 'WriteEvent', timestamp: at + 1, bytes: Buffer.from('\n').toString('base64') });
    t.vm.emit('Stdout', { kind: 'WriteEvent', timestamp: at + 3, bytes: Buffer.from('flutter: third\n').toString('base64') });
    t.start();
    await until(() => expect(t.events('log')).toHaveLength(3));
    expect(t.events('log').map((e: any) => e.payload.args[0])).toEqual(['first', 'second', 'third']);
  });

  it('is not late when profiling was on already, as DevTools leaves it', async () => {
    const t = await fixture({ age: 60_000, httpOn: true });
    t.start();
    await until(() => expect(t.sessions()).toHaveLength(1));
    expect(t.sessions()[0].info.attachedLate).toBeUndefined();
    t.stop();
    // Capybara did not turn it on, so it leaves it on.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(t.vm.httpOn()).toBe(true);
  });

  it('reads developer.log records in full, with their error and stack', async () => {
    const t = await fixture();
    t.start();
    await until(() => expect(t.sessions()).toHaveLength(1));
    t.vm.object('objects/message', { type: 'Instance', kind: 'String', valueAsString: 'x'.repeat(535) });
    t.vm.object('objects/error', {
      type: 'Instance',
      kind: 'PlainInstance',
      class: { name: 'StateError' },
      fields: [{ decl: { name: 'message' }, value: { kind: 'String', valueAsString: 'Payment declined' } }],
    });
    t.vm.object('objects/stack', { type: 'Instance', kind: 'StackTrace', valueAsString: '#0      pay (package:shop/pay.dart:4:3)' });
    t.vm.emit('Logging', {
      kind: 'Logging',
      logRecord: {
        level: 900,
        loggerName: { kind: 'String', valueAsString: 'checkout' },
        message: { kind: 'String', id: 'objects/message', valueAsString: 'x'.repeat(128), valueAsStringIsTruncated: true },
        error: { kind: 'PlainInstance', id: 'objects/error' },
        stackTrace: { kind: 'StackTrace', id: 'objects/stack', valueAsString: '#0 …', valueAsStringIsTruncated: true },
      },
    });
    await until(() => expect(t.events('log')).toHaveLength(1));
    expect(t.events('log')[0].payload).toEqual({
      level: 'warn',
      source: 'console',
      args: [
        `[checkout] ${'x'.repeat(535)}`,
        { $t: 'error', name: 'StateError', message: 'Payment declined', stack: '#0      pay (package:shop/pay.dart:4:3)' },
      ],
    });
  });

  it('reports Flutter errors as uncaught errors with their stack', async () => {
    const t = await fixture();
    t.start();
    await until(() => expect(t.sessions()).toHaveLength(1));
    t.vm.emit('Extension', {
      kind: 'Extension',
      extensionKind: 'Flutter.Error',
      extensionData: errorNode('Bad state: The cart failed to build', [
        '#0      _CartState.build (package:shop/cart.dart:42:7)',
        '#1      StatefulElement.build (package:flutter/src/widgets/framework.dart:5944:27)',
      ]),
    });
    await until(() => expect(t.events('log')).toHaveLength(1));
    expect(t.events('log')[0].payload).toEqual({
      level: 'error',
      source: 'uncaught',
      args: [
        {
          $t: 'error',
          name: 'StateError',
          message: 'Bad state: The cart failed to build',
          stack:
            '#0      _CartState.build (package:shop/cart.dart:42:7)\n#1      StatefulElement.build (package:flutter/src/widgets/framework.dart:5944:27)',
          props: {
            library: 'Exception caught by widgets library',
            context: 'The following StateError was thrown building Cart(dirty)',
            widget: 'Cart Cart:file:///Users/me/shop/lib/cart.dart:12:5',
          },
        },
      ],
    });
  });

  it('reports requests from the HTTP profile with their bodies, and failures', async () => {
    const t = await fixture();
    t.start();
    await until(() => expect(t.vm.httpOn()).toBe(true));
    const body = [...Buffer.from('{"ok":true}')];
    const start = 1_793_158_000_000_000;
    t.vm.addRequest({
      id: '-891763890423636828',
      method: 'POST',
      uri: 'http://127.0.0.1:4100/echo',
      startTime: start,
      endTime: start + 2_000,
      request: { headers: { 'content-type': ['application/json'], accept: ['a', 'b'] }, contentLength: body.length },
      response: { startTime: start + 12_000, endTime: start + 15_000, statusCode: 201, reasonPhrase: 'Created', headers: { 'content-type': ['application/json'] } },
      requestBody: body,
      responseBody: body,
    });
    t.vm.addRequest({ id: '7', method: 'GET', uri: 'http://127.0.0.1:9/', startTime: start, endTime: start + 7_000, request: { error: 'SocketException: Connection refused' } });
    await until(() => expect(t.events('network.error')).toHaveLength(1));
    expect(t.events('network.request')[0]).toMatchObject({
      ts: 1_793_158_000_000,
      payload: {
        id: 'dart--891763890423636828',
        initiator: 'other',
        method: 'POST',
        url: 'http://127.0.0.1:4100/echo',
        headers: { 'content-type': 'application/json', accept: 'a, b' },
        body: { kind: 'text', text: '{"ok":true}', size: 11 },
      },
    });
    expect(t.events('network.response')[0].payload).toMatchObject({
      status: 201,
      statusText: 'Created',
      duration: 12,
      body: { kind: 'text', text: '{"ok":true}' },
    });
    expect(t.events('network.error')[0].payload).toEqual({ id: 'dart-7', message: 'SocketException: Connection refused', duration: 7 });
  });

  it('shows a response that is still arriving as streaming, then complete', async () => {
    const t = await fixture();
    t.start();
    await until(() => expect(t.vm.httpOn()).toBe(true));
    const start = 1_793_158_000_000_000;
    const request = { id: '9', method: 'GET', uri: 'http://127.0.0.1:4100/slow', startTime: start, endTime: start + 1_000 };
    t.vm.addRequest({ ...request, response: { startTime: start + 5_000, statusCode: 200, headers: { 'content-type': ['text/plain'] } } });
    await until(() => expect(t.events('network.response')).toHaveLength(1));
    expect(t.events('network.response')[0].payload.streaming).toBe(true);
    t.vm.addRequest({
      ...request,
      response: { startTime: start + 5_000, endTime: start + 9_000, statusCode: 200, headers: { 'content-type': ['text/plain'] } },
      responseBody: [...Buffer.from('done')],
    });
    await until(() => expect(t.events('network.response')).toHaveLength(2));
    expect(t.events('network.response')[1].payload).toMatchObject({ body: { text: 'done' } });
    expect(t.events('network.response')[1].payload.streaming).toBeUndefined();
    expect(t.events('network.request')).toHaveLength(1);
  });

  it('starts a new session on hot restart, and turns profiling on again', async () => {
    const t = await fixture();
    t.start();
    await until(() => expect(t.vm.httpOn()).toBe(true));
    t.vm.restart();
    expect(t.vm.httpOn()).toBe(false);
    await until(() => expect(t.sessions().filter((s) => s.connected)).toHaveLength(1));
    await until(() => expect(new Set(t.sessions().map((s) => s.info.id)).size).toBe(2));
    await until(() => expect(t.vm.httpOn()).toBe(true));
  });

  it('leaves apps that run the Capybara package to it', async () => {
    const t = await fixture({ sdk: true });
    t.start();
    await until(() => expect(t.vm.calls.some((call) => call.method === 'getIsolate')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(t.sessions()).toEqual([]);
    expect(t.vm.httpOn()).toBe(false);
  });

  it('closes its session when the app starts the Capybara package later', async () => {
    const t = await fixture();
    t.start();
    await until(() => expect(t.sessions().filter((s) => s.connected)).toHaveLength(1));
    t.vm.addExtension('ext.capybara.status');
    await until(() => expect(t.sessions().filter((s) => s.connected)).toHaveLength(0));
    await until(() => expect(t.vm.httpOn()).toBe(false));
  });

  it('says once that an app it found has no Development Service it can reach', async () => {
    const t = await fixture({ noDds: true });
    t.start({ pollInterval: 10 });
    await until(() => expect(t.vm.probes()).toBeGreaterThan(0));
    expect(t.vm.calls).toEqual([]);
    // The first failure is retried after a while; tried again, it gives the hint.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11_000);
    await until(() => expect(t.hints).toHaveLength(1));
    vi.useRealTimers();
    expect(t.hints[0]).toContain('iPhone Duo');
    expect(t.hints[0]).not.toContain(TOKEN);
  });

  it('reads an app a viewer on this computer gives the address of', async () => {
    const t = await fixture({ scan: false });
    t.start();
    await until(() => expect(t.serverInfo()?.flutter).toEqual({ attach: true }));
    t.viewer.send(JSON.stringify({ t: 'attach', id: 'a1', uri: t.vm.uri }));
    await until(() => expect(t.messages.find((m) => m.t === 'result' && m.id === 'a1')).toEqual({ t: 'result', id: 'a1', ok: true, result: { appName: 'shop' } }));
    t.viewer.send(JSON.stringify({ t: 'attach', id: 'a2', uri: 'http://192.168.1.20:50300/abc=/' }));
    await until(() => expect(t.messages.find((m) => m.id === 'a2')?.ok).toBe(false));
    expect(t.messages.find((m) => m.id === 'a2').error).toContain('this computer');
    // The address is the app's key: it is never stored or sent on.
    expect(JSON.stringify(t.messages)).not.toContain(TOKEN);
  });
});

describe('finding Flutter apps', () => {
  it('reads the VM service address, device and package of a DDS process', () => {
    expect(
      parseDdsProcess(
        `9146 /Users/me/fvm/versions/3.47.8/bin/cache/dart-sdk/bin/dart development-service --vm-service-uri=http://127.0.0.1:61998/${TOKEN}/ --bind-address=127.0.0.1 --bind-port=0 --serve-devtools --app-name=Kind: Flutter - Device: sdk gphone64 arm64 - Package: shop`,
      ),
    ).toEqual({ pid: 9146, vmUri: `http://127.0.0.1:61998/${TOKEN}/`, device: 'sdk gphone64 arm64', packageName: 'shop' });
    expect(parseDdsProcess('123 /usr/bin/vim development-service.md')).toBeUndefined();
    expect(parseDdsProcess('77 dart development-service')).toBeUndefined();
  });

  it('follows only addresses on this computer, and hides their auth code', () => {
    expect(isLoopbackVmUri('http://127.0.0.1:1/x=/')).toBe(true);
    expect(isLoopbackVmUri('ws://localhost:1/x=/ws')).toBe(true);
    expect(isLoopbackVmUri('http://[::1]:1/x=/')).toBe(true);
    expect(isLoopbackVmUri('http://192.168.1.2:1/x=/')).toBe(false);
    expect(isLoopbackVmUri('file:///tmp')).toBe(false);
    expect(redactVmUri(`ws://127.0.0.1:62002/${TOKEN}/ws`)).toBe('ws://127.0.0.1:62002/…/ws');
    expect(redactVmUri(`http://127.0.0.1:1/devtools/?uri=ws%3A%2F%2F127.0.0.1%3A62002%2F${encodeURIComponent(TOKEN)}%2Fws`)).not.toContain(
      'QqL7EFEDNG0',
    );
  });

  it('gets DDS from the redirect both the VM service and DDS answer with', async () => {
    const vm = await fakeVmService();
    cleanups.push(() => vm.close());
    expect(await resolveDds(vm.uri)).toBe(vm.ddsUri);
    expect(await resolveDds(vm.ddsUri)).toBe(vm.ddsUri);
    expect(await resolveDds(vm.uri.replace(TOKEN, 'wrongtoken=/'))).toBeUndefined();
    expect(await resolveDds(`http://192.168.1.2:${vm.port}/${TOKEN}/`)).toBeUndefined();
  });
});

describe('reading what the VM service sends', () => {
  it('maps developer.log levels to log levels', () => {
    expect([0, 300, 500, 800, 900, 1000, 1200].map(logRecordLevel)).toEqual(['log', 'debug', 'debug', 'info', 'warn', 'error', 'error']);
  });

  it("makes one error of Flutter's printed error reports", () => {
    const entries: Array<[string, string]> = [];
    const reader = createPrintReader((text, level) => entries.push([level, text]));
    for (const line of [
      'flutter: ══╡ EXCEPTION CAUGHT BY RENDERING LIBRARY ╞═════════════',
      'flutter: A RenderFlex overflowed by 12 pixels on the right.',
      'flutter: ═════════════════════════════════════════════════════════',
      'flutter: Another exception was thrown: A RenderFlex overflowed by 3 pixels on the bottom.',
    ]) {
      reader.write(line, 'Stdout', 1);
      reader.write('\n', 'Stdout', 1);
    }
    expect(entries.map(([level, text]) => [level, text.split('\n').length])).toEqual([
      ['error', 3],
      ['error', 1],
    ]);
  });

  it('names assertion failures', () => {
    const node = errorNode('A RenderFlex overflowed by 12 pixels on the right.', []);
    node.properties[0]!.description = 'The following assertion was thrown during layout:';
    expect(flutterErrorPayload(node).args[0]).toMatchObject({ name: 'AssertionError', message: 'A RenderFlex overflowed by 12 pixels on the right.' });
  });
});
