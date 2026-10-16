import type { LogLevel } from '@capybara-devtools/protocol';
import type { Plugin } from '../client.js';

const LEVELS: LogLevel[] = ['debug', 'log', 'info', 'warn', 'error'];

export interface ConsolePluginOptions {
  /** Calls whose first argument is a string matching one of these are not recorded; they still print. */
  ignore?: RegExp[];
}

export function consolePlugin(options: ConsolePluginOptions = {}): Plugin {
  const ignore = options.ignore ?? [];
  const ignored = (args: unknown[]) => typeof args[0] === 'string' && ignore.some((pattern) => pattern.test(args[0] as string));
  return {
    name: 'console',
    setup(ctx) {
      const target = console as unknown as Record<LogLevel, (...args: unknown[]) => void>;
      const originals = new Map<LogLevel, (...args: unknown[]) => void>();
      // A getter or toJSON hit during serialization may log; recording that would recurse.
      let capturing = false;

      for (const level of LEVELS) {
        const original = target[level];
        if (typeof original !== 'function') continue;
        originals.set(level, original);
        target[level] = function (this: unknown, ...args: unknown[]) {
          if (!capturing && !ignored(args)) {
            capturing = true;
            try {
              ctx.emit('log', { level, source: 'console', args: args.map((arg) => ctx.serialize(arg)) });
            } catch {
              // logging must keep working even if capture fails
            } finally {
              capturing = false;
            }
          }
          return original.apply(this, args);
        };
      }

      return () => {
        for (const [level, original] of originals) target[level] = original;
      };
    },
  };
}
