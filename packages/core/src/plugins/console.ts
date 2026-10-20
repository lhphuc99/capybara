import { isUnhandledRejection, type LogLevel, type LogPayload, type SerializedValue } from '@capybara-devtools/protocol';
import type { Plugin } from '../client.js';

const LEVELS: LogLevel[] = ['debug', 'log', 'info', 'warn', 'error'];
const METHODS = ['table', 'group', 'groupCollapsed', 'groupEnd', 'time', 'timeLog', 'timeEnd', 'count', 'countReset', 'assert', 'trace'];

export interface ConsolePluginOptions {
  /** Calls whose first argument is a string matching one of these are not recorded; they still print. */
  ignore?: RegExp[];
}

type ConsoleMethod = (...args: unknown[]) => unknown;

export function consolePlugin(options: ConsolePluginOptions = {}): Plugin {
  const ignore = options.ignore ?? [];
  const ignored = (args: unknown[]) => typeof args[0] === 'string' && ignore.some((pattern) => pattern.test(args[0] as string));
  return {
    name: 'console',
    setup(ctx) {
      const target = console as unknown as Record<string, ConsoleMethod | undefined>;
      const patches = new Map<string, { original: ConsoleMethod; patched: ConsoleMethod }>();
      // A getter or toJSON hit during serialization may log; recording that would recurse.
      let capturing = false;
      let active = true;
      // What browsers keep per page between calls: open groups, timers and counters.
      let depth = 0;
      const timers = new Map<string, number>();
      const counts = new Map<string, number>();

      const serialize = (args: unknown[]) => args.map((arg) => ctx.serialize(arg));
      const emit = (level: LogLevel, args: SerializedValue[], method?: LogPayload['method']) => {
        const source = level === 'error' && isUnhandledRejection(args) ? 'unhandledrejection' : 'console';
        ctx.emit('log', { level, source, args, ...(depth > 0 && { depth }), ...(method && { method }) });
      };
      const now = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());
      const labelOf = (label: unknown) => (label === undefined ? 'default' : String(label));
      const elapsed = (label: string, data: unknown[], end: boolean) => {
        const start = timers.get(label);
        if (start === undefined) {
          emit('warn', [`Timer '${label}' does not exist`]);
          return;
        }
        if (end) timers.delete(label);
        emit('log', [`${label}: ${(now() - start).toFixed(3)} ms`, ...serialize(data)]);
      };

      /** Records a call of `name`; `caller` was created in the patch, so its stack starts at the app's call. */
      const record = (name: string, args: unknown[], caller: Error | undefined) => {
        switch (name) {
          case 'table':
            emit('log', serialize(args.slice(0, 2)), 'table');
            return;
          case 'group':
          case 'groupCollapsed':
            emit('log', args.length > 0 ? serialize(args) : [`console.${name}`], name);
            depth++;
            return;
          case 'groupEnd':
            depth = Math.max(0, depth - 1);
            return;
          case 'time': {
            const label = labelOf(args[0]);
            if (timers.has(label)) emit('warn', [`Timer '${label}' already exists`]);
            else timers.set(label, now());
            return;
          }
          case 'timeLog':
            elapsed(labelOf(args[0]), args.slice(1), false);
            return;
          case 'timeEnd':
            elapsed(labelOf(args[0]), [], true);
            return;
          case 'count': {
            const label = labelOf(args[0]);
            const n = (counts.get(label) ?? 0) + 1;
            counts.set(label, n);
            emit('log', [`${label}: ${n}`]);
            return;
          }
          case 'countReset': {
            const label = labelOf(args[0]);
            if (counts.has(label)) counts.set(label, 0);
            else emit('warn', [`Count for '${label}' does not exist`]);
            return;
          }
          case 'assert': {
            if (args[0]) return;
            const data = serialize(args.slice(1));
            const [first] = data;
            emit('error', typeof first === 'string' ? [`Assertion failed: ${first}`, ...data.slice(1)] : ['Assertion failed', ...data]);
            return;
          }
          case 'trace':
            emit('log', [...(args.length > 0 ? serialize(args) : ['console.trace']), ctx.serialize(traceOf(caller))], 'trace');
            return;
          default:
            emit(name as LogLevel, serialize(args));
        }
      };

      for (const name of [...LEVELS, ...METHODS]) {
        const original = target[name];
        if (typeof original !== 'function') continue;
        const patched = function (this: unknown, ...args: unknown[]) {
          if (active && !capturing && !ignored(args)) {
            capturing = true;
            try {
              record(name, args, name === 'trace' ? new Error() : undefined);
            } catch {
              // logging must keep working even if capture fails
            } finally {
              capturing = false;
            }
          }
          return original.apply(this, args);
        };
        target[name] = patched;
        patches.set(name, { original, patched });
      }

      return () => {
        // A wrapper installed after ours (LogBox, Sentry) stays; ours, still under it, then only passes calls on.
        active = false;
        for (const [name, { original, patched }] of patches) if (target[name] === patched) target[name] = original;
      };
    },
  };
}

/** An error named Trace whose stack starts at the caller of the console patch that created `caller`. */
function traceOf(caller: Error | undefined): Error {
  const trace = new Error();
  trace.name = 'Trace';
  const lines = (caller?.stack ?? '').split('\n').filter((line) => line.trim() !== '');
  // V8 and Hermes start with an "Error" line; Safari and Firefox list frames only. The first frame is the patch.
  const frames = lines[0] !== undefined && !lines[0].includes('@') && !/^\s*at /.test(lines[0]) ? lines.slice(2) : lines.slice(1);
  trace.stack = ['Trace', ...frames].join('\n');
  return trace;
}
