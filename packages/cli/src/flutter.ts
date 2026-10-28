import { randomUUID } from 'node:crypto';
import {
  CLIENT_PATH,
  DART_EXTENSION_PREFIX,
  FLUTTER_VM_SDK,
  MAX_STRING_LENGTH,
  type DartPackages,
  type SerializedValue,
  type SessionInfo,
} from '@capybara-devtools/protocol';
import { platformOf } from './cdp.js';
import { debug } from './debug.js';
import { isLoopbackVmUri, listProcesses, redactVmUri, resolveDds, scanDdsProcesses } from './flutter-discovery.js';
import {
  createPrintReader,
  flutterErrorPayload,
  logRecordPayload,
  type DiagnosticsNodeJson,
  type VmInstanceRef,
  type VmLogRecord,
} from './flutter-events.js';
import { createHttpProfileReader } from './flutter-network.js';
import { JsonRpcClient, openJsonRpcSocket } from './json-rpc.js';
import { MAX_HELD_EVENTS, openSession, type Session } from './metro-relay.js';

export interface FlutterBridgeOptions {
  /** Port of the Capybara server the apps are reported to. */
  port: number;
  /** Reported as the SDK version of these sessions. */
  version?: string;
  /** VM service or DDS addresses to read besides the apps found running (`--flutter-vm-service`). */
  vmServiceUris?: string[];
  /** Look for apps started by `flutter run` or an IDE. Default true. */
  scan?: boolean;
  /** Milliseconds between looks for apps. Default 2000. */
  pollInterval?: number;
  /** Milliseconds between reads of an app's HTTP profile. Default 1000. */
  httpInterval?: number;
  /** Told once per app that is found but cannot be read, with what to do instead. */
  onHint?: (message: string) => void;
  listProcesses?: () => Promise<string[]>;
  fetch?: typeof fetch;
}

export interface FlutterBridge {
  /** Reads the app at this VM service or DDS address, from a viewer on this computer. */
  attach(uri: string): Promise<{ appName: string }>;
  stop(): void;
}

interface VmEvent {
  kind: string;
  timestamp?: number;
  isolate?: { id: string; name?: string; isSystemIsolate?: boolean };
  bytes?: string;
  logRecord?: VmLogRecord;
  extensionKind?: string;
  extensionData?: DiagnosticsNodeJson;
  extensionRPC?: string;
  service?: string;
  method?: string;
}

interface VmIsolateRef {
  id: string;
  name?: string;
  isSystemIsolate?: boolean;
}

interface VmIsolate extends VmIsolateRef {
  startTime?: number;
  runnable?: boolean;
  rootLib?: { uri?: string };
  extensionRPCs?: string[];
}

interface VmInfo {
  operatingSystem?: string;
  version?: string;
  isolates?: VmIsolateRef[];
}

/** One run of the app's main isolate: a launch, or what follows a hot restart. */
interface Run {
  isolateId: string;
  state: 'deciding' | 'skipped' | 'streaming';
  /** Work held until it is known whether the app runs the Capybara package. */
  held: Array<() => Promise<void> | void>;
  decideTimer?: ReturnType<typeof setTimeout>;
  httpTimer?: ReturnType<typeof setInterval>;
  /** HTTP profiling was off and Capybara turned it on, so it turns it off again when done. */
  enabledHttp?: boolean;
  late?: boolean;
  session?: Session;
  print?: ReturnType<typeof createPrintReader>;
}

/** Methods the bridge calls. It only reads, except for switching dart:io's HTTP profiling on and back off. */
const ALLOWED = new Set([
  'setClientName',
  'getVM',
  'getIsolate',
  'getObject',
  'streamListen',
  'lookupResolvedPackageUris',
  'ext.dart.io.httpEnableTimelineLogging',
  'ext.dart.io.getHttpProfile',
  'ext.dart.io.getHttpProfileRequest',
]);

/** A new isolate that registers no Flutter extension within this time is read without waiting further. */
const DECIDE_LIMIT_MS = 3_000;
/** How often a found app whose Development Service does not answer is tried again. */
const RETRY_MS = 10_000;
/** How long the history DDS replays on attaching is collected before it is put in order. */
const REPLAY_MS = 300;

/**
 * Reads logs, Flutter errors and HTTP requests of Flutter apps in debug or profile mode through the Dart VM
 * service, the way Flutter DevTools does, so they show up without the Capybara package. Apps are found through
 * the Dart Development Service (DDS) process that `flutter run` and IDEs start beside each app, and only ever
 * read through it: a second client of the app's own VM service could keep DDS from starting.
 */
export function startFlutterBridge(options: FlutterBridgeOptions): FlutterBridge {
  const interval = options.pollInterval ?? 2_000;
  const capybaraUrl = `ws://127.0.0.1:${options.port}${CLIENT_PATH}`;
  const fetchImpl = options.fetch ?? fetch;
  const apps = new Map<string, AppWatcher>();
  const tried = new Map<string, number>();
  const hinted = new Set<string>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const watch = (dds: string, meta: AppMeta): AppWatcher => {
    let watcher = apps.get(dds);
    if (!watcher) {
      watcher = watchApp(dds, meta, {
        capybaraUrl,
        port: options.port,
        version: options.version ?? '0.0.0',
        httpInterval: options.httpInterval ?? 1_000,
        onEnd: () => apps.delete(dds),
      });
      apps.set(dds, watcher);
    }
    return watcher;
  };

  // Lookups are retried, but not every two seconds once they fail: DDS answers within a second of starting.
  const lookUp = async (uri: string, meta: AppMeta, hintKey?: string) => {
    const last = tried.get(uri);
    if (last !== undefined && Date.now() - last < RETRY_MS) return;
    const dds = await resolveDds(uri, fetchImpl);
    if (stopped) return;
    if (!dds) {
      if (last !== undefined && hintKey && !hinted.has(hintKey)) {
        hinted.add(hintKey);
        options.onHint?.(
          `A Flutter app${meta.device ? ` on ${meta.device}` : ''} is running, but Capybara could not reach its Dart Development Service. Restart it with flutter run, or give Capybara the address flutter run prints ("A Dart VM Service … is available at").`,
        );
      }
      tried.set(uri, Date.now());
      debug(`No Dart Development Service answered at ${redactVmUri(uri)}`);
      return;
    }
    tried.delete(uri);
    if (!apps.has(dds)) debug(`Reading the Flutter app at ${redactVmUri(dds)}${meta.device ? ` on ${meta.device}` : ''}`);
    watch(dds, meta);
  };

  const poll = async () => {
    const found = options.scan === false ? [] : await scanDdsProcesses(options.listProcesses ?? listProcesses);
    const live = new Set<string>();
    for (const proc of found) {
      live.add(proc.vmUri);
      await lookUp(proc.vmUri, { device: proc.device, packageName: proc.packageName }, `pid ${proc.pid}`);
    }
    for (const uri of options.vmServiceUris ?? []) await lookUp(uri, {});
    for (const uri of tried.keys()) if (!live.has(uri) && !options.vmServiceUris?.includes(uri)) tried.delete(uri);
    if (stopped) return;
    timer = setTimeout(() => void poll(), interval);
    timer.unref();
  };
  void poll();

  return {
    async attach(uri) {
      if (!isLoopbackVmUri(uri)) throw new Error('Capybara reads Flutter apps only at an address on this computer (127.0.0.1 or localhost).');
      const dds = await resolveDds(uri, fetchImpl);
      if (!dds) {
        throw new Error(
          'No Flutter app answers at that address. Copy the one flutter run prints: "A Dart VM Service on … is available at: http://127.0.0.1:…/…=/".',
        );
      }
      if (stopped) throw new Error('Capybara is shutting down');
      const watcher = watch(dds, {});
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('The Flutter app did not answer in time.')), 10_000);
      });
      try {
        return { appName: await Promise.race([watcher.ready, late]) };
      } finally {
        clearTimeout(timeout);
      }
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      for (const app of [...apps.values()]) app.close();
    },
  };
}

interface AppMeta {
  device?: string;
  packageName?: string;
}

interface AppWatcher {
  /** The app's name once its main isolate is known; rejects when the app cannot be read. */
  ready: Promise<string>;
  close(): void;
}

function watchApp(
  dds: string,
  meta: AppMeta,
  context: { capybaraUrl: string; port: number; version: string; httpInterval: number; onEnd: () => void },
): AppWatcher {
  const runs = new Map<string, Run>();
  const controller = new AbortController();
  const services = new Map<string, string>();
  let vm: VmInfo = {};
  let flutterVersion: string | undefined;
  let ended = false;
  // Events are handled one at a time so they reach the UI in the order the app produced them.
  let queue: Promise<void> = Promise.resolve();
  let resolveReady!: (name: string) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {});

  const rpc = new JsonRpcClient((method, params) => {
    if (method === 'streamNotify') onEvent(params as { streamId: string; event: VmEvent });
  });
  const call = <T>(method: string, params?: object): Promise<T> =>
    ALLOWED.has(method) || method === services.get('flutterVersion')
      ? rpc.call<T>(method, params)
      : Promise.reject(new Error(`${method} is not called on Flutter apps`));

  const label = () => `${meta.packageName ?? 'A Flutter app'}${meta.device ? ` (${meta.device})` : ''}`;

  const enqueue = (work: () => Promise<void> | void) => {
    queue = queue.then(work).catch((error: unknown) => debug(`Could not read an event from ${label()}`, error));
  };

  const end = () => {
    if (ended) return;
    ended = true;
    controller.abort();
    rejectReady(new Error(`Could not read ${label()}`));
    for (const run of [...runs.values()]) endRun(run);
    // Profiling is switched back off before the socket closes; the app keeps running either way.
    void queue.finally(() => {
      rpc.close();
      context.onEnd();
    });
  };

  const sessionInfo = async (run: Run, isolate: VmIsolate): Promise<SessionInfo> => {
    const root = /^package:([^/]+)\/(.+)$/.exec(isolate.rootLib?.uri ?? '');
    const appName = root?.[1] ?? meta.packageName ?? 'Flutter app';
    const packages: DartPackages = { app: [appName] };
    if (root) {
      const resolved = await call<{ uris?: Array<string | null> }>('lookupResolvedPackageUris', {
        isolateId: isolate.id,
        uris: [isolate.rootLib!.uri],
      }).catch(() => undefined);
      const file = resolved?.uris?.[0];
      if (file?.startsWith('file://') && file.endsWith(root[2]!)) {
        packages.dirs = { [appName]: decodeURIComponent(file.slice('file://'.length, -root[2]!.length)) };
      }
    }
    const platform = platformOf(vm.operatingSystem);
    const dart = /^(\S+)/.exec(vm.version ?? '')?.[1];
    return {
      id: randomUUID(),
      appName,
      platform,
      sdk: { name: FLUTTER_VM_SDK, version: context.version },
      startedAt: Date.now(),
      device: {
        model: meta.device,
        isEmulator: platform === 'android' && /sdk_gphone|sdk gphone|emulator|generic/i.test(meta.device ?? '') ? true : undefined,
      },
      runtime: [flutterVersion && `Flutter ${flutterVersion}`, dart && `Dart ${dart}`, 'via Dart VM service'].filter(Boolean).join(' · '),
      dartPackages: packages,
      ...(run.late && { attachedLate: true }),
    };
  };

  const endRun = (run: Run) => {
    runs.delete(run.isolateId);
    clearTimeout(run.decideTimer);
    clearInterval(run.httpTimer);
    run.print?.flush();
    run.session?.close();
    run.held = [];
    if (run.enabledHttp) {
      run.enabledHttp = false;
      enqueue(() =>
        call('ext.dart.io.httpEnableTimelineLogging', { isolateId: run.isolateId, enabled: 'false' }).then(
          () => {},
          () => {},
        ),
      );
    }
  };

  const enableHttp = async (run: Run) => {
    if (run.state === 'skipped' || run.enabledHttp !== undefined) return;
    const state = await call<{ enabled?: boolean }>('ext.dart.io.httpEnableTimelineLogging', { isolateId: run.isolateId }).catch(
      () => undefined,
    );
    if (!state || run.enabledHttp !== undefined) return;
    run.enabledHttp = false;
    if (!state.enabled) {
      await call('ext.dart.io.httpEnableTimelineLogging', { isolateId: run.isolateId, enabled: 'true' });
      run.enabledHttp = true;
    }
  };

  const stream = async (run: Run) => {
    if (run.state !== 'deciding' || ended) return;
    clearTimeout(run.decideTimer);
    const isolate = await call<VmIsolate>('getIsolate', { isolateId: run.isolateId }).catch(() => undefined);
    if (runs.get(run.isolateId) !== run || run.state !== 'deciding') return;
    if (!isolate) {
      // Not runnable yet: look again later rather than never.
      run.decideTimer = setTimeout(() => enqueue(() => stream(run)), DECIDE_LIMIT_MS);
      return;
    }
    if (usesPackage(isolate)) {
      skip(run);
      return;
    }
    run.state = 'streaming';
    const info = await sessionInfo(run, isolate);
    resolveReady(info.appName);
    meta.packageName ??= info.appName;
    debug(`Reading ${label()} through the Dart VM service`);
    const session = openSession(context.capybaraUrl, info, end, (command) =>
      command.plugin === 'storage' && command.method === 'list'
        ? Promise.resolve([])
        : Promise.reject(new Error('This needs the Capybara package for Flutter')),
    );
    run.session = session;
    run.print = createPrintReader((text, level, ts) => session.emit('log', { level, source: 'console', args: [text] }, ts));
    const reader = createHttpProfileReader(call, run.isolateId, session.emit, {
      ignore: (url) => isCapybaraUrl(url, context.port),
    });
    let polling = false;
    run.httpTimer = setInterval(() => {
      if (polling || run.enabledHttp === undefined) return;
      polling = true;
      void reader
        .poll()
        .catch((error: unknown) => debug(`Could not read the HTTP profile of ${label()}`, error))
        .finally(() => (polling = false));
    }, context.httpInterval);
    run.httpTimer.unref();
    for (const work of run.held) enqueue(work);
    run.held = [];
  };

  const skip = (run: Run) => {
    debug(`${label()} runs the Capybara package, so the Dart VM service leaves it to the package`);
    rejectReady(new Error('This app runs the Capybara package, which sends it to Capybara already.'));
    clearTimeout(run.decideTimer);
    run.session?.close();
    run.session = undefined;
    run.state = 'skipped';
    run.held = [];
    clearInterval(run.httpTimer);
    if (run.enabledHttp) {
      run.enabledHttp = false;
      void call('ext.dart.io.httpEnableTimelineLogging', { isolateId: run.isolateId, enabled: 'false' }).catch(() => {});
    }
  };

  const startRun = (isolate: VmIsolateRef, existing: VmIsolate | undefined) => {
    if (runs.has(isolate.id) || isolate.isSystemIsolate) return;
    const run: Run = { isolateId: isolate.id, state: 'deciding', held: [] };
    runs.set(isolate.id, run);
    if (existing) {
      // Requests made before profiling was on are lost: DDS keeps logs for a late client, not requests.
      run.late = Date.now() - (existing.startTime ?? Date.now()) > 2_000;
      if (usesPackage(existing)) {
        skip(run);
        return;
      }
    }
    enqueue(() => enableHttp(run).then(() => {
      if (run.late && run.enabledHttp === false) run.late = false;
    }));
    if (existing?.extensionRPCs?.some((rpc) => rpc.startsWith('ext.flutter.'))) {
      enqueue(() => stream(run));
    } else {
      run.decideTimer = setTimeout(() => enqueue(() => stream(run)), DECIDE_LIMIT_MS);
    }
  };

  // Work for a run: done now when streaming, held while deciding, dropped when the package has the app.
  const forRun = (isolateId: string | undefined, work: (run: Run) => Promise<void> | void) => {
    const run = isolateId ? runs.get(isolateId) : runs.size === 1 ? [...runs.values()][0] : undefined;
    if (!run || run.state === 'skipped') return;
    const job = () => (run.state === 'streaming' && runs.get(run.isolateId) === run ? work(run) : undefined);
    if (run.state === 'streaming') enqueue(job);
    else if (run.held.length < MAX_HELD_EVENTS) run.held.push(job);
  };

  // DDS replays each stream's history in turn when it is listened to; held here and sorted by time, the logs
  // of before Capybara attached keep their order across streams.
  let replay: Array<{ streamId: string; event: VmEvent }> | undefined;

  const onEvent = (notice: { streamId: string; event: VmEvent }) => {
    if (replay && notice.streamId !== 'Isolate' && notice.streamId !== 'Service') {
      replay.push(notice);
      return;
    }
    route(notice);
  };

  const route = ({ streamId, event }: { streamId: string; event: VmEvent }) => {
    const isolateId = event.isolate?.id;
    switch (streamId) {
      case 'Service':
        if (event.kind === 'ServiceRegistered' && event.service && event.method) services.set(event.service, event.method);
        return;
      case 'Isolate':
        if (!event.isolate || event.isolate.isSystemIsolate) return;
        if (event.kind === 'IsolateStart' || event.kind === 'IsolateRunnable') {
          if (event.isolate.name === 'main') startRun(event.isolate, undefined);
        } else if (event.kind === 'IsolateExit') {
          const run = runs.get(event.isolate.id);
          if (run) endRun(run);
        } else if (event.kind === 'ServiceExtensionAdded' && event.extensionRPC) {
          const run = runs.get(event.isolate.id);
          if (!run) return;
          if (event.extensionRPC.startsWith(DART_EXTENSION_PREFIX)) skip(run);
          else if (event.extensionRPC === 'ext.dart.io.httpEnableTimelineLogging') enqueue(() => enableHttp(run));
          else if (event.extensionRPC.startsWith('ext.flutter.') && run.state === 'deciding') enqueue(() => stream(run));
        }
        return;
      case 'Stdout':
      case 'Stderr':
        if (event.kind !== 'WriteEvent' || !event.bytes) return;
        forRun(isolateId, (run) =>
          run.print?.write(Buffer.from(event.bytes!, 'base64').toString('utf8'), streamId, event.timestamp ?? Date.now()),
        );
        return;
      case 'Logging':
        if (!event.logRecord) return;
        forRun(isolateId, async (run) => {
          const record = event.logRecord!;
          const message = await fullString(record.message, run.isolateId);
          const error = await errorValue(record.error, record.stackTrace, run.isolateId);
          run.session?.emit('log', logRecordPayload(record, message, error), event.timestamp ?? Date.now());
        });
        return;
      case 'Extension':
        if (event.extensionKind !== 'Flutter.Error' || !event.extensionData) return;
        forRun(isolateId, (run) =>
          run.session?.emit('log', flutterErrorPayload(event.extensionData!), event.timestamp ?? Date.now()),
        );
        return;
    }
  };

  const fullString = async (ref: VmInstanceRef | undefined, isolateId: string): Promise<string> => {
    if (!ref || ref.kind === 'Null') return '';
    if (!ref.valueAsStringIsTruncated || !ref.id) return ref.valueAsString ?? '';
    const object = await call<VmInstanceRef>('getObject', { isolateId, objectId: ref.id, count: MAX_STRING_LENGTH }).catch(
      () => undefined,
    );
    return object?.valueAsString ?? ref.valueAsString ?? '';
  };

  // The error's class and message, read from its fields: calling its toString() would run code in the app.
  const errorValue = async (
    error: VmInstanceRef | undefined,
    stackTrace: VmInstanceRef | undefined,
    isolateId: string,
  ): Promise<SerializedValue | undefined> => {
    if (!error || error.kind === 'Null') return undefined;
    const stack = stackTrace && stackTrace.kind !== 'Null' && stackTrace.id
      ? await call<VmInstanceRef>('getObject', { isolateId, objectId: stackTrace.id }).then((s) => s.valueAsString, () => undefined)
      : undefined;
    if (error.kind === 'String') return { $t: 'error', name: 'Error', message: await fullString(error, isolateId), ...(stack && { stack }) };
    const object = error.id
      ? await call<{ class?: { name?: string }; fields?: Array<{ decl?: { name?: string }; name?: string; value?: VmInstanceRef }> }>(
          'getObject',
          { isolateId, objectId: error.id },
        ).catch(() => undefined)
      : undefined;
    const field = object?.fields?.find((f) => (f.decl?.name ?? f.name) === 'message')?.value;
    const message = field && field.kind === 'String' ? field.valueAsString ?? '' : error.valueAsString ?? '';
    return { $t: 'error', name: object?.class?.name ?? 'Error', message, ...(stack && { stack }) };
  };

  void (async () => {
    const socket = await openJsonRpcSocket(dds, controller.signal);
    if (!socket || ended) {
      socket?.terminate();
      end();
      return;
    }
    rpc.attach(socket);
    socket.on('close', end);
    socket.on('error', (error) => debug(`Lost the Dart VM service connection to ${label()}`, error));
    try {
      await call('setClientName', { name: 'Capybara' }).catch(() => {});
      // DDS answers with the services the flutter tool registered, such as its version, right away.
      await call('streamListen', { streamId: 'Service' }).catch(() => {});
      vm = await call<VmInfo>('getVM');
      await new Promise((resolve) => setTimeout(resolve, 200));
      const versionMethod = services.get('flutterVersion');
      if (versionMethod) {
        flutterVersion = await call<{ frameworkVersion?: string }>(versionMethod).then(
          (reply) => reply.frameworkVersion,
          () => undefined,
        );
      }
      const listen = (streamId: string) =>
        call('streamListen', { streamId }).catch((error: unknown) => debug(`streamListen ${streamId} failed for ${label()}`, error));
      await listen('Isolate');
      for (const ref of vm.isolates ?? []) {
        if (ref.isSystemIsolate || ref.name !== 'main') continue;
        const isolate = await call<VmIsolate>('getIsolate', { isolateId: ref.id }).catch(() => undefined);
        if (isolate) startRun(ref, isolate);
      }
      // After the runs exist: DDS replays the logs and errors it kept as soon as these are listened to.
      replay = [];
      for (const streamId of ['Stdout', 'Stderr', 'Logging', 'Extension']) await listen(streamId);
      await new Promise((resolve) => setTimeout(resolve, REPLAY_MS));
      const replayed = replay;
      replay = undefined;
      for (const notice of replayed.sort((a, b) => (a.event.timestamp ?? 0) - (b.event.timestamp ?? 0))) route(notice);
    } catch (error) {
      debug(`Could not read ${label()} through the Dart VM service`, error);
      end();
    }
  })();

  return { ready, close: end };
}

function usesPackage(isolate: VmIsolate): boolean {
  return isolate.extensionRPCs?.some((rpc) => rpc.startsWith(DART_EXTENSION_PREFIX)) ?? false;
}

/** The Capybara package's own connection to this server, which the app's HTTP profile also records. */
function isCapybaraUrl(url: string, port: number): boolean {
  try {
    const parsed = new URL(url);
    return Number(parsed.port) === port && parsed.pathname.startsWith(CLIENT_PATH);
  } catch {
    return false;
  }
}
