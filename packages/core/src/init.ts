import { CLIENT_PATH, DEFAULT_PORT } from '@capybara-devtools/protocol';
import { createClient, getActiveClient, type CapybaraClient, type ClientOptions, type Plugin } from './client.js';
import { consolePlugin } from './plugins/console.js';
import { networkPlugin, type NetworkPluginOptions } from './plugins/network.js';
import { statePlugin, type StatePluginOptions } from './plugins/state/index.js';
import { storagePlugin, type StorageAdapter } from './plugins/storage.js';

/** The options of `init()` on every platform; each SDK adds its own, and documents the defaults it picks. */
export interface CommonInitOptions {
  /** Shown in the session picker. */
  appName?: string;
  /** Machine running `capybara`. */
  host?: string;
  /** Port the Capybara server listens on, as set by `capybara --port` or `CAPYBARA_PORT`. Default 7357. */
  port?: number;
  /** Pass false to skip setup. */
  enabled?: boolean;
  /** Run in a release build too. Off by default, so an `init()` left without a dev check never runs for the app's users. */
  allowProduction?: boolean;
  /** Capture console output and uncaught errors. Default true. */
  logs?: boolean;
  network?: boolean | NetworkPluginOptions;
  /** Show the app's Redux, Zustand, TanStack Query and SWR stores, and its React Context values. Default true. */
  state?: boolean | StatePluginOptions;
  plugins?: Plugin[];
}

/** What one platform adds to `init()`, read only once it goes ahead. */
export interface PlatformSetup {
  /** Where Capybara runs when `host` is not given. */
  host: string;
  session: ClientOptions['session'];
  /** Records uncaught errors the platform's way. */
  errors: Plugin;
  /** Console messages a framework prints on every start, left out. */
  consoleNoise?: RegExp[];
  /** Traffic of the platform's own dev tools, left out of the Network tab. */
  networkNoise: RegExp[];
  /** Without adapters, the Storage tab is off. */
  storage?: StorageAdapter[];
}

/** The part of `init()` the SDKs share: whether to run, the plugins to turn on, and the connection. */
export function initClient(options: CommonInitOptions, production: boolean, platform: () => PlatformSetup): CapybaraClient | undefined {
  if (options.enabled === false) return undefined;
  if (production && !options.allowProduction) return undefined;
  // Hot reload re-runs the entry file; patching again would record everything twice.
  const existing = getActiveClient();
  if (existing) return existing;

  const setup = platform();
  const plugins: Plugin[] = [];
  if (options.logs !== false) plugins.push(consolePlugin({ ignore: setup.consoleNoise }), setup.errors);
  if (options.network !== false) {
    const network = typeof options.network === 'object' ? options.network : {};
    plugins.push(networkPlugin({ ...network, ignoreUrls: [...setup.networkNoise, ...(network.ignoreUrls ?? [])] }));
  }
  if (setup.storage) plugins.push(storagePlugin(setup.storage));
  if (options.state !== false) plugins.push(statePlugin(typeof options.state === 'object' ? options.state : {}));
  plugins.push(...(options.plugins ?? []));

  const host = options.host ?? setup.host;
  // An IPv6 address needs its brackets in a URL.
  const address = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return createClient({ url: `ws://${address}:${options.port ?? DEFAULT_PORT}${CLIENT_PATH}`, session: setup.session, plugins });
}
