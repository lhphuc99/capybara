import type { LogLevel } from '@capybara/protocol';
import type { Plugin } from '../client.js';

const LEVELS: LogLevel[] = ['debug', 'log', 'info', 'warn', 'error'];

export function consolePlugin(): Plugin {
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
          if (!capturing) {
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
