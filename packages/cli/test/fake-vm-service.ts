import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';

// A Dart Development Service in front of a Flutter app, as far as the bridge uses one. Shapes follow what
// Flutter 3.47.8 (Dart 3.13.7, DDS 2.1) sent in the spike: see plans/…/reports/02-vm-service-spike.md.

export const TOKEN = 'QqL7EFEDNG0=';

export interface FakeHttpRequest {
  id: string;
  method: string;
  uri: string;
  startTime: number;
  endTime?: number;
  request?: { headers?: Record<string, string[]>; contentLength?: number; error?: string };
  response?: {
    startTime?: number;
    endTime?: number;
    statusCode?: number;
    reasonPhrase?: string;
    headers?: Record<string, string[]>;
    contentLength?: number;
    error?: string;
  };
  requestBody?: number[];
  responseBody?: number[];
}

const HISTORY_STREAMS = new Set(['Stdout', 'Stderr', 'Logging', 'Extension']);

export async function fakeVmService(
  options: {
    /** The app runs the Capybara package from the start. */
    sdk?: boolean;
    /** Milliseconds since the app's isolate started. */
    age?: number;
    /** HTTP profiling is already on, as DevTools leaves it. */
    httpOn?: boolean;
    /** The app has no Development Service, as with `flutter run --no-dds`. */
    noDds?: boolean;
    /** Milliseconds to wait before answering these methods. */
    slow?: Record<string, number>;
    /** With the package: it reached Capybara on its own, or does once given an address it can reach. */
    packageConnected?: boolean;
    packageReachable?: boolean;
  } = {},
) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let probes = 0;
  const subscriptions = new Map<WebSocket, Set<string>>();
  const history: Array<{ streamId: string; event: Record<string, unknown> }> = [];
  const objects = new Map<string, unknown>();
  let isolate = newIsolate(1, Date.now() - (options.age ?? 0), options.sdk);
  let httpOn = options.httpOn ?? false;
  let packageConnected = options.packageConnected ?? false;
  const packageReachable = options.packageReachable ?? false;
  const packageTargets: string[] = [];
  let requests: Array<FakeHttpRequest & { updated: number }> = [];
  let clock = 1_000;

  function newIsolate(n: number, startTime: number, sdk?: boolean) {
    return {
      id: `isolates/${n}`,
      startTime,
      extensions: [
        'ext.dart.io.httpEnableTimelineLogging',
        'ext.dart.io.getHttpProfile',
        'ext.dart.io.getHttpProfileRequest',
        'ext.flutter.platformOverride',
        ...(sdk ? ['ext.capybara.status'] : []),
      ],
    };
  }

  const server = http.createServer((req, res) => {
    probes++;
    if (!req.url?.startsWith(`/${TOKEN}/`)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (options.noDds) {
      res.writeHead(200);
      res.end('Dart VM service');
      return;
    }
    res.writeHead(302, {
      location: `http://127.0.0.1:${port}/${TOKEN}/devtools/?uri=${encodeURIComponent(`ws://127.0.0.1:${port}/${TOKEN}/ws`)}`,
    });
    res.end();
  });
  const sockets = new WebSocketServer({ server, path: `/${TOKEN}/ws` });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const send = (ws: WebSocket, streamId: string, event: Record<string, unknown>) =>
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'streamNotify', params: { streamId, event } }));

  const emit = (streamId: string, event: Record<string, unknown>) => {
    const full = { isolate: { id: isolate.id, name: 'main', isSystemIsolate: false }, timestamp: Date.now(), ...event };
    if (HISTORY_STREAMS.has(streamId)) history.push({ streamId, event: full });
    for (const [ws, streams] of subscriptions) if (streams.has(streamId)) send(ws, streamId, full);
  };

  const strip = ({ requestBody: _request, responseBody: _response, updated: _updated, ...rest }: FakeHttpRequest & { updated: number }) => rest;

  sockets.on('connection', (ws) => {
    subscriptions.set(ws, new Set());
    ws.on('close', () => subscriptions.delete(ws));
    ws.on('message', (data) => {
      const { id, method, params = {} } = JSON.parse(data.toString()) as { id: string; method: string; params?: Record<string, any> };
      calls.push({ method, params });
      const wait = options.slow?.[method] ?? 0;
      const reply = (result: unknown) => {
        const send = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
        if (wait > 0) setTimeout(send, wait);
        else send();
      };
      const fail = (code: number, message: string) => ws.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
      switch (method) {
        case 'setClientName':
          return reply({ type: 'Success' });
        case 'getVM':
          return reply({
            type: 'VM',
            operatingSystem: 'ios',
            version: '3.13.7 (stable) (Thu Oct 22 14:28:57 2026 -0700) on "ios_arm64"',
            isolates: [{ type: '@Isolate', id: isolate.id, name: 'main', isSystemIsolate: false }],
          });
        case 'getIsolate':
          if (params.isolateId !== isolate.id) return fail(105, 'Isolate must be runnable');
          return reply({
            type: 'Isolate',
            id: isolate.id,
            name: 'main',
            startTime: isolate.startTime,
            runnable: true,
            rootLib: { uri: 'package:shop/main.dart' },
            extensionRPCs: isolate.extensions,
          });
        case 'streamListen': {
          subscriptions.get(ws)!.add(params.streamId);
          reply({ type: 'Success' });
          if (params.streamId === 'Service') {
            for (const service of ['reloadSources', 'hotRestart', 'flutterVersion', 'compileExpression']) {
              send(ws, 'Service', { kind: 'ServiceRegistered', service, method: `s1.${service}`, alias: 'Flutter Tools' });
            }
          }
          for (const entry of history) if (entry.streamId === params.streamId) send(ws, entry.streamId, entry.event);
          return;
        }
        case 's1.flutterVersion':
          return reply({ type: 'Success', frameworkVersion: '3.47.8', dartSdkVersion: '3.13.7' });
        case 'lookupResolvedPackageUris':
          return reply({ type: 'UriList', uris: (params.uris as string[]).map((uri) => uri.replace('package:shop/', 'file:///Users/me/shop/lib/')) });
        case 'getObject':
          return objects.has(params.objectId) ? reply(objects.get(params.objectId)) : fail(113, 'Object expired');
        case 'ext.capybara.status':
          return reply({ type: '_extensionType', method, connected: packageConnected });
        case 'ext.capybara.connect':
          packageTargets.push(`${params.host}:${params.port}`);
          if (packageReachable) packageConnected = true;
          return reply({ type: '_extensionType', method, target: `ws://${params.host}:${params.port}/client` });
        case 'ext.dart.io.httpEnableTimelineLogging':
          if (params.enabled !== undefined) httpOn = params.enabled === 'true';
          return reply({ type: 'HttpTimelineLoggingState', enabled: httpOn });
        case 'ext.dart.io.getHttpProfile': {
          const since = params.updatedSince === undefined ? -1 : Number(params.updatedSince);
          return reply({ type: 'HttpProfile', timestamp: clock, requests: requests.filter((r) => r.updated > since).map(strip) });
        }
        case 'ext.dart.io.getHttpProfileRequest': {
          const found = requests.find((r) => r.id === params.id);
          if (!found) return fail(-32602, 'No request');
          const { updated: _updated, ...rest } = found;
          return reply({ type: 'HttpProfileRequest', ...rest });
        }
        default:
          return fail(-32601, `Method not found: ${method}`);
      }
    });
  });

  return {
    port,
    calls,
    uri: `http://127.0.0.1:${port}/${TOKEN}/`,
    ddsUri: `ws://127.0.0.1:${port}/${TOKEN}/ws`,
    psLine: `4242 /Users/me/fvm/versions/3.47.8/bin/cache/dart-sdk/bin/dart development-service --vm-service-uri=http://127.0.0.1:${port}/${TOKEN}/ --bind-address=127.0.0.1 --bind-port=0 --serve-devtools --app-name=Kind: Flutter - Device: iPhone Duo - Package: shop`,
    httpOn: () => httpOn,
    /** Where the bridge told the package to connect. */
    packageTargets: () => packageTargets,
    /** Plain HTTP requests, which is how the bridge asks where DDS is. */
    probes: () => probes,
    isolateId: () => isolate.id,
    clients: () => subscriptions.size,
    /** What `print(text)` makes the engine write: the text with Flutter's tag, then the newline. */
    print(text: string, stream = 'Stdout') {
      emit(stream, { kind: 'WriteEvent', bytes: Buffer.from(`flutter: ${text}`).toString('base64') });
      emit(stream, { kind: 'WriteEvent', bytes: Buffer.from('\n').toString('base64') });
    },
    emit,
    object(id: string, value: unknown) {
      objects.set(id, value);
    },
    addRequest(request: FakeHttpRequest) {
      requests = requests.filter((r) => r.id !== request.id);
      requests.push({ ...request, updated: ++clock });
    },
    addExtension(name: string) {
      isolate.extensions.push(name);
      emit('Isolate', { kind: 'ServiceExtensionAdded', extensionRPC: name });
    },
    /** A hot restart: the isolate exits and a new one starts, with profiling off again. */
    restart() {
      const old = isolate;
      emit('Isolate', { kind: 'IsolateExit', isolate: { id: old.id, name: 'main', isSystemIsolate: false } });
      isolate = newIsolate(Number(old.id.split('/')[1]) + 1, Date.now());
      httpOn = false;
      requests = [];
      emit('Isolate', { kind: 'IsolateStart' });
      for (const name of isolate.extensions) emit('Isolate', { kind: 'ServiceExtensionAdded', extensionRPC: name });
      emit('Isolate', { kind: 'IsolateRunnable' });
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of sockets.clients) ws.terminate();
        sockets.close();
        server.close(() => resolve());
      }),
  };
}
