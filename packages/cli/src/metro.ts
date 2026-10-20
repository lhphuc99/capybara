import { randomUUID } from 'node:crypto';
import { CLIENT_GLOBAL } from '@capybara-devtools/core';
import { CLIENT_PATH, MAX_SOCKET_MESSAGE_SIZE, METRO_SDK, type SessionInfo } from '@capybara-devtools/protocol';
import { platformOf } from './cdp.js';
import { debug } from './debug.js';
import { CdpClient, CdpError, connect, METHOD_NOT_FOUND, type CdpEvent, type EvaluateResult } from './metro-debugger.js';
import { relayEvent, releaseEvent, type ConsoleCall, type Request } from './metro-events.js';
import { watchMetroMMKV } from './metro-mmkv.js';
import { MAX_HELD_EVENTS, openSession, type Session } from './metro-relay.js';
import { readMetroStorage } from './metro-storage.js';
import { watchMetroWebSockets } from './metro-websocket.js';

/** Expo moves to 8082 when 8081 is taken. */
export const DEFAULT_METRO_PORTS = [8081, 8082];

export interface MetroBridgeOptions {
  /** Port of the Capybara server the apps are reported to. */
  port: number;
  metroPorts?: number[];
  /** Reported as the SDK version of these sessions. */
  version?: string;
  /** Milliseconds between looks for apps. Default 2000. */
  pollInterval?: number;
  /** Told once per Metro target that cannot be read, with what to do instead. */
  onHint?: (message: string) => void;
}

export interface MetroBridge {
  stop(): void;
}

const RETRY_AFTER_FAILURE_MS = 30_000;
/** A starting app is checked this often for the SDK until its entry file has run. */
const STARTUP_CHECK_MS = 1_000;
const STARTUP_LIMIT_MS = 30_000;

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

/** One JS context of the app: a launch or a reload. */
interface Run {
  contextId: number;
  startedAt: number;
  state: 'deciding' | 'skipped' | 'streaming';
  /** Events held until it is known whether the app has the SDK. */
  held: CdpEvent[];
  checking: boolean;
  /** Something changed while a check was unanswered, so its answer may be out of date. */
  recheck: boolean;
  sawRunning: boolean;
  retry?: ReturnType<typeof setTimeout>;
  session?: Session;
  mmkv?: ReturnType<typeof watchMetroMMKV>;
  sockets?: ReturnType<typeof watchMetroWebSockets>;
  requests: Map<string, Request>;
}

/**
 * Reads logs and network of React Native apps through Metro's debugger endpoint, the one React
 * Native DevTools uses, so apps show up without the SDK. Apps that have the SDK are left alone, and
 * so are apps whose JS engine cannot be debugged, such as Expo Go on Android.
 */
export function startMetroBridge(options: MetroBridgeOptions): MetroBridge {
  const metroPorts = options.metroPorts ?? DEFAULT_METRO_PORTS;
  const interval = options.pollInterval ?? 2_000;
  const capybaraUrl = `ws://127.0.0.1:${options.port}${CLIENT_PATH}`;
  const version = options.version ?? '0.0.0';
  const apps = new Map<string, { close(): void }>();
  const hinted = new Set<string>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scan = async (metroPort: number) => {
    for (const target of (await listTargets(metroPort)) ?? []) {
      // Without this capability a second debugger would disconnect React Native DevTools.
      if (!target?.reactNative?.capabilities?.supportsMultipleDebuggers ||
          typeof target.id !== 'string' || typeof target.webSocketDebuggerUrl !== 'string') continue;
      const key = `${metroPort} ${target.id}`;
      if (stopped || apps.has(key)) continue;
      // Once per target, not per connection: the target is reconnected whenever its socket drops.
      const hint = (message: string) => {
        if (hinted.has(key)) return;
        hinted.add(key);
        options.onHint?.(message);
      };
      apps.set(key, watchApp(target, metroPort, capybaraUrl, version, () => apps.delete(key), hint));
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
  capybaraUrl: string,
  version: string,
  onEnd: () => void,
  onUnreadable: (hint: string) => void,
): { close(): void } {
  let metadata: AppMetadata = {};
  let run: Run | undefined;
  // Processing is sequential so events reach the UI in the order the app produced them.
  let queue: Promise<void> = Promise.resolve();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  const controller = new AbortController();
  const cdp = new CdpClient((event) => onEvent(event));
  const { call, release } = cdp;

  const end = () => {
    if (ended) return;
    ended = true;
    controller.abort();
    clearTimeout(retryTimer);
    // Give the runtime a chance to restore its methods before closing CDP. A lease in the app
    // also expires the hooks if the socket has already disappeared or the process is killed.
    void endRun().finally(() => {
      cdp.close();
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

  const label = () => {
    const device = metadata.deviceName || target.deviceName;
    return `${metadata.appDisplayName || target.title || target.appId || 'A React Native app'}${device ? ` (${device})` : ''}`;
  };

  const unreadableHint = () => {
    const device = metadata.deviceName || target.deviceName;
    const expoGo = /^host\.exp\.exponent$/i.test(target.appId ?? '');
    const platform = metadata.platform === 'android' ? 'Android' : metadata.platform === 'ios' ? 'iOS' : undefined;
    const name = expoGo
      ? `Expo Go${platform ? ` on ${platform}` : ''}`
      : metadata.appDisplayName || target.appId || target.title || 'A React Native app';
    return (
      `${name}${device ? ` (${device})` : ''} can't be read through Metro: its JavaScript engine does not support debugging. ` +
      `Capybara shows it only when the app runs the SDK (@capybara-devtools/react-native)${expoGo ? ', or as a development build' : ''}.`
    );
  };

  const startRun = (contextId: number) => {
    void endRun();
    const current: Run = {
      contextId,
      startedAt: Date.now(),
      state: 'deciding',
      held: [],
      checking: false,
      recheck: false,
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
    for (const event of current.held) releaseEvent(event, release);
    current.held = [];
    current.session?.close();
    current.requests.clear();
    return Promise.all([current.mmkv?.stop(), current.sockets?.stop()]).then(() => {});
  };

  const decide = async (current: Run) => {
    if (current.state !== 'deciding') return;
    if (current.checking) {
      current.recheck = true;
      return;
    }
    current.checking = true;
    const probe = await call<EvaluateResult>('Runtime.evaluate', {
      expression: PROBE_APP, contextId: current.contextId, returnByValue: true,
    }).then(
      (reply) => parseProbe(reply.result?.value),
      // React Native's answer when the engine cannot be debugged over CDP, as in Expo Go on Android. Such an app
      // sends no logs and cannot be checked for the SDK, so a session would be empty or a duplicate of the SDK's.
      (error: unknown) => {
        if (error instanceof CdpError && error.code === METHOD_NOT_FOUND) return 'unreadable';
        debug(`Could not check ${label()} for the SDK`, error);
        return undefined;
      },
    );
    current.checking = false;
    if (run !== current || current.state !== 'deciding') return;
    if (probe === 'unreadable' || probe?.sdk) {
      if (probe !== 'unreadable') debug(`${label()} runs the SDK, so Metro leaves it to the SDK`);
      current.state = 'skipped';
      for (const event of current.held) releaseEvent(event, release);
      current.held = [];
      if (probe === 'unreadable') onUnreadable(unreadableHint());
      return;
    }
    // The app may have started its SDK after answering, e.g. when `Running "App"` arrived meanwhile.
    if (current.recheck) {
      current.recheck = false;
      void decide(current);
      return;
    }
    // An SDK starts in the entry file, which a launching app may not have run yet.
    const starting = !probe?.ready && !current.sawRunning && Date.now() - current.startedAt < STARTUP_LIMIT_MS;
    if (starting) {
      current.retry = setTimeout(() => void decide(current), STARTUP_CHECK_MS);
      return;
    }
    debug(`Reading ${label()} through Metro on port ${metroPort}`);
    current.state = 'streaming';
    current.mmkv = watchMetroMMKV(call, current.contextId);
    current.sockets = watchMetroWebSockets(call, current.contextId, {
      // Metro's own sockets (HMR, inspector), React DevTools and Reactotron. React Native opens some
      // of them with an http:// URL.
      ignoreUrls: [{ source: `^(?:wss?|https?)://[^/]+:(?:${metroPort}|8097|9090)(?:/|$)`, flags: '' }],
      ignoreProtocols: [],
      maxMessage: MAX_SOCKET_MESSAGE_SIZE,
    });
    current.session = openSession(capybaraUrl, sessionInfo(probe?.name), end, (command) => {
      if (command.plugin !== 'storage') return Promise.reject(new Error('This plugin is unavailable through Metro'));
      return readMetroStorage(call, current.contextId, () => run === current, command.method, command.params);
    });
    for (const event of current.held) enqueue(current, event);
    current.held = [];
  };

  const enqueue = (current: Run, event: CdpEvent) => {
    queue = queue
      .then(() => handle(current, event))
      .catch((error: unknown) => debug(`Could not read ${event.method} from ${label()}`, error));
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
      releaseEvent(event, release);
    } else if (current.state === 'deciding') {
      if (current.held.length >= MAX_HELD_EVENTS) releaseEvent(current.held.shift()!, release);
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

  const handle = async (current: Run, event: CdpEvent) => {
    const session = current.session;
    if (!session || current !== run) {
      releaseEvent(event, release);
      return;
    }
    await relayEvent(event, {
      session,
      call,
      release,
      contextId: current.contextId,
      requests: current.requests,
      metroPort,
      label,
    });
  };

  void (async () => {
    const connected = await connect(target.webSocketDebuggerUrl!, metroPort, controller.signal);
    if (ended) {
      connected?.terminate();
      return;
    }
    if (!connected) {
      debug(`Could not attach to ${label()} through Metro on port ${metroPort}; trying again in ${RETRY_AFTER_FAILURE_MS / 1_000} s`);
      // Leaves the target out of the next few scans instead of failing every two seconds.
      retryTimer = setTimeout(end, RETRY_AFTER_FAILURE_MS);
      retryTimer.unref();
      return;
    }
    cdp.attach(connected);
    connected.on('close', end);
    connected.on('error', (error) => debug(`Lost the debugger connection to ${label()}`, error));
    // Metadata first, so it is there when the JS context shows up.
    for (const domain of ['ReactNativeApplication', 'Runtime', 'Network']) {
      await call(`${domain}.enable`).catch((error: unknown) => debug(`${domain}.enable failed for ${label()}`, error));
    }
  })();

  return { close: end };
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
