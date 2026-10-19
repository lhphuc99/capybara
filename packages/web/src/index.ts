import {
  consolePlugin,
  createClient,
  getActiveClient,
  networkPlugin,
  statePlugin,
  storagePlugin,
  type CapybaraClient,
  type NetworkPluginOptions,
  type Plugin,
  type StatePluginOptions,
  type StorageAdapter,
} from '@capybara-devtools/core';
import { CLIENT_PATH, DEFAULT_PORT } from '@capybara-devtools/protocol';
import { windowErrorsPlugin } from './errors.js';
import { cookieStorage, webStorage } from './storage.js';

export const SDK_VERSION = '0.5.0';

/** Traffic of a dev server's own tooling: Next.js error overlay requests and its HMR socket. */
const DEV_SERVER_NOISE = [/\/__nextjs_[\w-]+(\?|$)/, /\/_next\/webpack-hmr(\?|$)/];
/** React's development build prints this on every page when the React DevTools extension is missing. */
const CONSOLE_NOISE = [/Download the React DevTools for a better development experience/];

export interface InitOptions {
  /** Shown in the session picker. Defaults to the page title. */
  appName?: string;
  /** Machine running `capybara`. Defaults to the hostname the page was loaded from. */
  host?: string;
  /** Port the Capybara server listens on, as set by `capybara --port` or `CAPYBARA_PORT`. Default 7357. */
  port?: number;
  /** Pass false to skip setup, e.g. `enabled: import.meta.env.DEV`. */
  enabled?: boolean;
  /**
   * Run in a production build too, e.g. a staging build for testers. Off by default, so an `init()` left without
   * a dev check never runs for the app's users.
   */
  allowProduction?: boolean;
  /** Capture console output and uncaught errors. Default true. */
  logs?: boolean;
  network?: boolean | NetworkPluginOptions;
  /** `false` turns storage off; an array adds adapters next to localStorage, sessionStorage and cookies. */
  storage?: boolean | StorageAdapter[];
  /** Show the app's Redux, Zustand, TanStack Query and SWR stores, and its React Context values. Default true. */
  state?: boolean | StatePluginOptions;
  plugins?: Plugin[];
}

// Only typed here: the SDK has no Node types, and bundlers replace the expression before it runs.
declare const process: { env: { NODE_ENV?: string } };

/** Bundlers write the build mode into `process.env.NODE_ENV`; unbundled, there is no `process` and reading it throws. */
function isProductionBuild(): boolean {
  try {
    return process.env.NODE_ENV === 'production';
  } catch {
    return false;
  }
}

export function init(options: InitOptions = {}): CapybaraClient | undefined {
  // The window check makes this a no-op during server rendering, so the same entry works in Next.js.
  if (options.enabled === false || typeof window === 'undefined') return undefined;
  if (isProductionBuild() && !options.allowProduction) return undefined;
  // Hot reload re-runs the entry file; patching again would record everything twice.
  const existing = getActiveClient();
  if (existing) return existing;

  const plugins: Plugin[] = [];
  if (options.logs !== false) plugins.push(consolePlugin({ ignore: CONSOLE_NOISE }), windowErrorsPlugin());
  if (options.network !== false) {
    const network = typeof options.network === 'object' ? options.network : {};
    plugins.push(
      networkPlugin({ ...network, ignoreUrls: [...DEV_SERVER_NOISE, ...metroSockets(), ...(network.ignoreUrls ?? [])] }),
    );
  }
  if (options.storage !== false) {
    const extra = Array.isArray(options.storage) ? options.storage : [];
    plugins.push(storagePlugin([...defaultStorages(), ...extra]));
  }
  if (options.state !== false) plugins.push(statePlugin(typeof options.state === 'object' ? options.state : {}));
  plugins.push(...(options.plugins ?? []));

  const host = options.host ?? (window.location.hostname || 'localhost');
  return createClient({
    url: `ws://${formatHost(host)}:${options.port ?? DEFAULT_PORT}${CLIENT_PATH}`,
    session: {
      appName: options.appName ?? (document.title || window.location.host || 'Web app'),
      platform: 'web',
      sdk: { name: '@capybara-devtools/web', version: SDK_VERSION },
      url: window.location.href,
      userAgent: navigator.userAgent,
    },
    plugins,
  });
}

function defaultStorages(): StorageAdapter[] {
  const adapters: StorageAdapter[] = [];
  // Reading these throws in sandboxed iframes and when site data is blocked.
  try {
    adapters.push(webStorage(window.localStorage, 'localStorage', 'Local Storage'));
  } catch {
    // unavailable
  }
  try {
    adapters.push(webStorage(window.sessionStorage, 'sessionStorage', 'Session Storage'));
  } catch {
    // unavailable
  }
  adapters.push(cookieStorage());
  return adapters;
}

/** With Expo web, Metro serves the page and also opens /hot and /message sockets on the same origin. */
function metroSockets(): RegExp[] {
  const host = window.location.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return host ? [new RegExp(`^wss?://${host}/(?:hot|message)(?:[/?]|$)`)] : [];
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export {
  capybaraReduxEnhancer,
  connectReduxStore,
  getActiveClient,
  swrMiddleware,
  swrProvider,
  watchQueryClient,
  watchSWR,
  watchZustand,
} from '@capybara-devtools/core';
export type {
  CapybaraClient,
  NetworkPluginOptions,
  Plugin,
  QueryClientLike,
  ReduxStoreEnhancer,
  ReduxStoreLike,
  ReduxStoreOptions,
  StatePluginOptions,
  StorageAdapter,
  SWRCacheLike,
  SWRHandle,
  WatchQueryClientOptions,
  WatchSWROptions,
  WatchZustandOptions,
  ZustandStoreLike,
} from '@capybara-devtools/core';
export { cookieStorage, webStorage } from './storage.js';
