import {
  consolePlugin,
  createClient,
  getActiveClient,
  networkPlugin,
  storagePlugin,
  type DevsightClient,
  type NetworkPluginOptions,
  type Plugin,
  type StorageAdapter,
} from '@devsight/core';
import { CLIENT_PATH, DEFAULT_PORT } from '@devsight/protocol';
import { windowErrorsPlugin } from './errors.js';
import { cookieStorage, webStorage } from './storage.js';

export const SDK_VERSION = '0.1.0';

export interface InitOptions {
  /** Shown in the session picker. Defaults to the page title. */
  appName?: string;
  /** Machine running `devsight`. Defaults to the hostname the page was loaded from. */
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

export function init(options: InitOptions = {}): DevsightClient | undefined {
  // The window check makes this a no-op during server rendering, so the same entry works in Next.js.
  if (options.enabled === false || typeof window === 'undefined') return undefined;
  // Hot reload re-runs the entry file; patching again would record everything twice.
  const existing = getActiveClient();
  if (existing) return existing;

  const plugins: Plugin[] = [];
  if (options.logs !== false) plugins.push(consolePlugin(), windowErrorsPlugin());
  if (options.network !== false) {
    plugins.push(networkPlugin(typeof options.network === 'object' ? options.network : {}));
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
      sdk: { name: '@devsight/web', version: SDK_VERSION },
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

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export { getActiveClient } from '@devsight/core';
export type { DevsightClient, NetworkPluginOptions, Plugin, StorageAdapter } from '@devsight/core';
export { cookieStorage, webStorage } from './storage.js';
