import {
  consolePlugin,
  createClient,
  getActiveClient,
  networkPlugin,
  storagePlugin,
  type CapybaraClient,
  type NetworkPluginOptions,
  type Plugin,
  type StorageAdapter,
} from '@capybara-devtools/core';
import { CLIENT_PATH, DEFAULT_PORT, type DeviceInfo, type Platform as CapybaraPlatform } from '@capybara-devtools/protocol';
import { NativeModules, Platform } from 'react-native';
import { errorUtilsPlugin } from './errors.js';
import { devToolSockets, formatHost, hostFromUrl, portFromUrl } from './host.js';

export const SDK_VERSION = '0.2.0';

/** Requests React Native sends to Metro on its own (LogBox symbolication, "open in editor"). */
const DEV_SERVER_NOISE = [/\/symbolicate(\?|$)/, /\/open-stack-frame(\?|$)/];

export interface InitOptions {
  /** Shown in the session picker. */
  appName?: string;
  /** Machine running `capybara`. Defaults to the host serving the JS bundle (Metro). */
  host?: string;
  port?: number;
  /** Pass false to skip setup, e.g. `enabled: __DEV__`. */
  enabled?: boolean;
  /** Capture console output and uncaught errors. Default true. */
  logs?: boolean;
  network?: boolean | NetworkPluginOptions;
  /** e.g. `[asyncStorage(AsyncStorage), mmkvStorage(storage)]` */
  storage?: StorageAdapter[];
  plugins?: Plugin[];
}

export function init(options: InitOptions = {}): CapybaraClient | undefined {
  if (options.enabled === false) return undefined;
  // Fast Refresh can re-run the entry file; patching again would record everything twice.
  const existing = getActiveClient();
  if (existing) return existing;

  const plugins: Plugin[] = [];
  if (options.logs !== false) plugins.push(consolePlugin(), errorUtilsPlugin());
  if (options.network !== false) {
    const network = typeof options.network === 'object' ? options.network : {};
    plugins.push(
      networkPlugin({
        fetch: !fetchRunsOnXhr(),
        xhr: true,
        ...network,
        ignoreUrls: [...DEV_SERVER_NOISE, ...devToolSockets(portFromUrl(bundleUrl() ?? '')), ...(network.ignoreUrls ?? [])],
      }),
    );
  }
  // Registered even when empty so the UI can explain how to add adapters.
  plugins.push(storagePlugin(options.storage ?? []));
  plugins.push(...(options.plugins ?? []));

  return createClient({
    url: `ws://${formatHost(options.host ?? defaultHost())}:${options.port ?? DEFAULT_PORT}${CLIENT_PATH}`,
    session: {
      appName: options.appName ?? `React Native (${Platform.OS})`,
      platform: platformName(),
      sdk: { name: '@capybara-devtools/react-native', version: SDK_VERSION },
      device: deviceInfo(),
      runtime: runtimeName(),
    },
    plugins,
  });
}

/**
 * Bare React Native ships whatwg-fetch, which runs on XHR, so patching fetch as well would record
 * every request twice. Expo (SDK 52+) swaps in a native fetch that never touches XHR.
 */
function fetchRunsOnXhr(): boolean {
  return (globalThis as { fetch?: { polyfill?: boolean } }).fetch?.polyfill === true;
}

function bundleUrl(): string | undefined {
  try {
    const sourceCode = NativeModules.SourceCode as
      | { scriptURL?: string; getConstants?: () => { scriptURL?: string } }
      | undefined;
    const scriptURL = sourceCode?.getConstants?.().scriptURL ?? sourceCode?.scriptURL;
    return typeof scriptURL === 'string' ? scriptURL : undefined;
  } catch {
    return undefined;
  }
}

function defaultHost(): string {
  const url = bundleUrl();
  const host = url ? hostFromUrl(url) : undefined;
  if (host) return host;
  // Bundles loaded from disk have no host; these addresses reach the dev machine from simulators and emulators.
  return Platform.OS === 'android' ? '10.0.2.2' : 'localhost';
}

function platformName(): CapybaraPlatform {
  const os: string = Platform.OS;
  return os === 'ios' || os === 'android' || os === 'windows' || os === 'macos' || os === 'web' ? os : 'unknown';
}

function platformConstants(): Record<string, unknown> {
  return ((Platform as unknown as { constants?: Record<string, unknown> }).constants ?? {}) as Record<string, unknown>;
}

function deviceInfo(): DeviceInfo {
  const c = platformConstants();
  if (Platform.OS === 'android') {
    const model = [c.Manufacturer, c.Model].filter(Boolean).join(' ');
    return {
      model: model || undefined,
      osVersion: `Android ${String(c.Release ?? Platform.Version)}`,
      isEmulator: /generic|emulator|sdk_gphone/i.test(String(c.Fingerprint ?? '')),
    };
  }
  if (Platform.OS === 'ios') {
    return {
      model: c.interfaceIdiom === 'pad' ? 'iPad' : 'iPhone',
      osVersion: `${String(c.systemName ?? 'iOS')} ${String(c.osVersion ?? Platform.Version)}`,
    };
  }
  return { osVersion: `${Platform.OS} ${String(Platform.Version)}` };
}

function runtimeName(): string {
  const engine = (globalThis as { HermesInternal?: unknown }).HermesInternal ? 'Hermes' : 'JSC';
  const version = platformConstants().reactNativeVersion as { major: number; minor: number; patch: number } | undefined;
  return version ? `${engine} · RN ${version.major}.${version.minor}.${version.patch}` : engine;
}

export { getActiveClient } from '@capybara-devtools/core';
export type { CapybaraClient, NetworkPluginOptions, Plugin, StorageAdapter } from '@capybara-devtools/core';
export { asyncStorage, mmkvStorage } from './storage.js';
export type { AdapterOptions, AsyncStorageLike, MMKVLike } from './storage.js';
