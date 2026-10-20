import { MAX_SOCKET_MESSAGE_SIZE } from '@capybara-devtools/protocol';
import type { Plugin } from '../client.js';
import { isXhrFetch, patchFetch } from './network/fetch.js';
import { resolveSettings, type NetworkPluginOptions } from './network/settings.js';
import { patchXhr } from './network/xhr.js';
import { hookWebSockets } from './websocket.js';

export type { NetworkPluginOptions } from './network/settings.js';

/** Vite's dev server channel. */
const DEV_TOOL_PROTOCOLS = ['vite-hmr', 'vite-ping'];

export function networkPlugin(options: NetworkPluginOptions = {}): Plugin {
  return {
    name: 'network',
    setup(ctx) {
      const settings = resolveSettings(options);
      const teardowns: Array<() => void> = [() => settings.failures.stop()];
      const fetchOverXhr = options.xhr !== false && isXhrFetch();
      if (options.fetch !== false && !fetchOverXhr) teardowns.push(patchFetch(ctx, settings));
      if (options.xhr !== false) teardowns.push(patchXhr(ctx, settings, fetchOverXhr));
      if (options.websocket !== false) {
        teardowns.push(
          hookWebSockets(ctx.emit, {
            ignoreUrls: (options.ignoreUrls ?? []).map((pattern) =>
              typeof pattern === 'string' ? pattern : { source: pattern.source, flags: pattern.flags },
            ),
            ignoreProtocols: DEV_TOOL_PROTOCOLS,
            maxMessage: options.maxMessageSize ?? MAX_SOCKET_MESSAGE_SIZE,
          }),
        );
      }
      return () => {
        for (const teardown of teardowns) teardown();
      };
    },
  };
}
