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
} from '@capybara/core';
import { CLIENT_PATH, DEFAULT_PORT } from '@capybara/protocol';
import { windowErrorsPlugin } from './errors.js';
import { cookieStorage, webStorage } from './storage.js';

export const SDK_VERSION = '0.1.0';

/** Traffic of a dev server's own tooling: Next.js error overlay requests and its HMR socket. */
const DEV_SERVER_NOISE = [/\/__nextjs_[\w-]+(\?|$)/, /\/_next\/webpack-hmr(\?|$)/];

export interface InitOptions {
  /** Shown in the session picker. Defaults to the page title. */
  appName?: string;
  /** Machine running `capybara`. Defaults to the hostname the page was loaded from. */
  host?: string;
  port?: number;
  /** Pass false to skip setup, e.g. `enabled: import.meta.env.DEV`. */
  enabled?: boolean;
  /** Capture console output and uncaught errors. Default true. */
  logs?: boolean;
  network?: boolean | NetworkPluginOptions;
  /** `false` turns storage off; an array adds adapters next to localStorage, sessionStorage and cookies. */
  storage?: boolean | StorageAdapter[];
  plugins?: Plugin[];
}

export function init(options: InitOptions = {}): CapybaraClient | undefined {
  // The window check makes this a no-op during server rendering, so the same entry works in Next.js.
  if (options.enabled === false || typeof window === 'undefined') return undefined;
  // Hot reload re-runs the entry file; patching again would record everything twice.
  const existing = getActiveClient();
  if (existing) return existing;

  const plugins: Plugin[] = [];
  if (options.logs !== false) plugins.push(consolePlugin(), windowErrorsPlugin());
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
  plugins.push(...(options.plugins ?? []));

  const host = options.host ?? (window.location.hostname || 'localhost');
  return createClient({
    url: `ws://${formatHost(host)}:${options.port ?? DEFAULT_PORT}${CLIENT_PATH}`,
    session: {
      appName: options.appName ?? (document.title || window.location.host || 'Web app'),
      platform: 'web',
      sdk: { name: '@capybara/web', version: SDK_VERSION },
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

export { getActiveClient } from '@capybara/core';
export type { CapybaraClient, NetworkPluginOptions, Plugin, StorageAdapter } from '@capybara/core';
export { cookieStorage, webStorage } from './storage.js';
