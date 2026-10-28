import {
  dartStackTop,
  formatLogMessage,
  isExpandable,
  isSpecial,
  valueText,
  type LogEntry,
  type LogLevel,
  type LogSource,
} from '@capybara-devtools/protocol';
import type { Redactor } from './mcp-redact.js';
import { clock, indent, searchMatcher } from './mcp-text.js';

const SOURCE_LABELS: Record<LogSource, string | null> = {
  console: null,
  api: 'api',
  uncaught: 'uncaught',
  unhandledrejection: 'unhandled rejection',
};

export interface LogQuery {
  level?: LogLevel[];
  search?: string;
  source?: LogSource;
  after?: number;
  before?: number;
}

export function filterLogs(logs: LogEntry[], query: LogQuery, redact: Redactor): LogEntry[] {
  const matcher = searchMatcher(query.search);
  return logs.filter((entry) => {
    if (query.level && !query.level.includes(entry.level)) return false;
    if (query.source && entry.source !== query.source) return false;
    if (query.after !== undefined && entry.seq <= query.after) return false;
    if (query.before !== undefined && entry.seq >= query.before) return false;
    if (!matcher) return true;
    const args = entry.args.map(redact.value);
    return matcher.test(`${formatLogMessage(args)}\n${JSON.stringify(args)}`);
  });
}

/** One log entry: its line, then (in full) each object and error, or (in a list) the top of each stack. */
export function logText(entry: LogEntry, redact: Redactor, full: boolean): string {
  const args = entry.args.map(redact.value);
  const source = SOURCE_LABELS[entry.source];
  // Entries in console.group() calls are indented under the group's line, as browsers show them.
  const lead = `${'  '.repeat(entry.depth ?? 0)}${entry.method === 'group' || entry.method === 'groupCollapsed' ? '▸ ' : ''}`;
  const head = `#${entry.seq} ${clock(entry.ts)} ${entry.level.toUpperCase().padEnd(5)} ${lead}${source ? `(${source}) ` : ''}${formatLogMessage(args)}`;
  const details = full
    ? args.filter((arg) => isExpandable(arg) || (isSpecial(arg) && arg.$t === 'string')).map((arg) => valueText(arg))
    : args.flatMap((arg) => (isSpecial(arg) && arg.$t === 'error' && arg.stack ? [stackTop(arg.stack, arg.message, arg.name)] : []));
  return [head, ...details.filter(Boolean).map((detail) => indent(detail, '    '))].join('\n');
}

function stackTop(stack: string, message: string, name: string): string {
  // Flutter's and the Dart SDK's own frames often fill the top of a Dart stack: show where the app was instead.
  const dart = dartStackTop(stack);
  if (dart.length > 0) return dart.join('\n');
  // Errors without a message, such as console.trace()'s, start their stack with just the name.
  const frames = stack.split('\n').filter((line) => line.trim() && (message ? !line.includes(message) : line.trim() !== name));
  return frames.slice(0, 3).map((line) => line.trim()).join('\n');
}
