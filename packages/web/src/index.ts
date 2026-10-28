import { initClient, type CapybaraClient, type CommonInitOptions, type StorageAdapter } from '@capybara-devtools/core';
import { windowErrorsPlugin } from './errors.js';
import { cookieStorage, webStorage } from './storage.js';

export const SDK_VERSION = '0.6.1';

/** Traffic of a dev server's own tooling: Next.js error overlay requests and its HMR socket. */
const DEV_SERVER_NOISE = [/\/__nextjs_[\w-]+(\?|$)/, /\/_next\/webpack-hmr(\?|$)/];
/** React's development build prints this on every page when the React DevTools extension is missing. */
const CONSOLE_NOISE = [/Download the React DevTools for a better development experience/];

export interface InitOptions extends CommonInitOptions {
  /** Shown in the session picker. Defaults to the page title. */
  appName?: string;
  /** Machine running `capybara`. Defaults to the hostname the page was loaded from. */
  host?: string;
  /** Pass false to skip setup, e.g. `enabled: import.meta.env.DEV`. */
  enabled?: boolean;
  /**
   * Run in a production build too, e.g. a staging build for testers. Off by default, so an `init()` left without
   * a dev check never runs for the app's users.
   */
  allowProduction?: boolean;
  /** `false` turns storage off; an array adds adapters next to localStorage, sessionStorage and cookies. */
  storage?: boolean | StorageAdapter[];
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
  if (typeof window === 'undefined') return undefined;
  return initClient(options, isProductionBuild(), () => ({
    host: window.location.hostname || 'localhost',
    session: {
      appName: options.appName ?? (document.title || window.location.host || 'Web app'),
      platform: 'web',
      sdk: { name: '@capybara-devtools/web', version: SDK_VERSION },
      url: window.location.href,
      userAgent: navigator.userAgent,
    },
    errors: windowErrorsPlugin(),
    consoleNoise: CONSOLE_NOISE,
    networkNoise: [...DEV_SERVER_NOISE, ...metroSockets()],
    storage: options.storage === false ? undefined : [...defaultStorages(), ...(Array.isArray(options.storage) ? options.storage : [])],
  }));
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

export {
  capybaraReduxEnhancer,
  connectReduxStore,
  getActiveClient,
  swrMiddleware,
  swrProvider,
  watchQueryClient,
  watchSWR,
  watchMobX,
  watchXState,
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
  MobxLike,
  WatchMobXOptions,
  WatchXStateOptions,
  WatchZustandOptions,
  XStateActorLike,
  ZustandStoreLike,
} from '@capybara-devtools/core';
export { cookieStorage, webStorage } from './storage.js';
