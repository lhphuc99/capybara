import type {
  SerializedValue,
  SpecialValue,
  StateChangePayload,
  StateDiffOp,
  StateLibrary,
  StatePath,
} from './index.js';

// Reading captured values: shared by the UI and the MCP server, so both describe a value the same way.

export function isSpecial(value: SerializedValue): value is SpecialValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { $t?: unknown }).$t === 'string'
  );
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export function formatKey(key: string): string {
  return IDENTIFIER.test(key) ? key : JSON.stringify(key);
}

function shortString(text: string, max = 60): string {
  return JSON.stringify(text.length > max ? `${text.slice(0, max)}…` : text);
}

function list(parts: string[], total: number): string {
  return parts.join(', ') + (total > parts.length ? ', …' : '');
}

/**
 * Collapsed one-line form of a value, like devtools shows it: `{id: 1, tags: Array(2)}`.
 * `raw` treats the value as plain JSON (response bodies), ignoring `$t` tags.
 */
export function preview(value: SerializedValue, raw = false, nested = false): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return shortString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (nested) return `Array(${value.length})`;
    return `[${list(value.slice(0, 5).map((v) => preview(v, raw, true)), value.length)}]`;
  }
  if (!raw && isSpecial(value)) return previewSpecial(value, nested);
  const record = value as Record<string, SerializedValue>;
  const keys = Object.keys(record);
  if (nested) return keys.length > 0 ? '{…}' : '{}';
  return `{${list(keys.slice(0, 5).map((k) => `${formatKey(k)}: ${preview(record[k]!, raw, true)}`), keys.length)}}`;
}

function previewSpecial(v: SpecialValue, nested: boolean): string {
  switch (v.$t) {
    case 'undefined':
      return 'undefined';
    case 'number':
      return v.v;
    case 'bigint':
      return `${v.v}n`;
    case 'symbol':
      return v.v;
    case 'function':
      return `ƒ ${v.name}()`;
    case 'date':
      return v.v;
    case 'regexp':
      return v.v;
    case 'error':
      return v.message ? `${v.name}: ${v.message}` : v.name;
    case 'string':
      return shortString(v.v);
    case 'array':
      if (nested) return `Array(${v.length})`;
      return `[${list(v.items.slice(0, 5).map((i) => preview(i, false, true)), v.length)}]`;
    case 'object': {
      const prefix = v.name ? `${v.name} ` : '';
      const keys = Object.keys(v.props);
      if (nested) return `${prefix}{${keys.length > 0 || v.more ? '…' : ''}}`;
      const parts = keys.slice(0, 5).map((k) => `${formatKey(k)}: ${preview(v.props[k]!, false, true)}`);
      return `${prefix}{${list(parts, keys.length + (v.more ?? 0))}}`;
    }
    case 'map':
      return `Map(${v.size})`;
    case 'set':
      return `Set(${v.size})`;
    case 'binary':
      return `${v.name} (${formatBytes(v.size)})`;
    case 'node':
      return v.v;
    case 'circular':
      return '[Circular]';
    case 'limit':
      return `[${v.name}]`;
  }
}

/** Values a log row can expand into a tree. */
export function isExpandable(value: SerializedValue): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isSpecial(value)) {
    if (value.$t === 'object') return Object.keys(value.props).length > 0 || !!value.more;
    return value.$t === 'error' || value.$t === 'array' || value.$t === 'map' || value.$t === 'set';
  }
  return Object.keys(value).length > 0;
}

/**
 * A captured value as plain JSON, for copying. Tagged values become what JSON can hold (dates their
 * ISO text, Maps objects, Sets arrays, errors their fields), and cut values say how much is missing.
 */
export function plainValue(value: SerializedValue, raw = false): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => plainValue(item, raw));
  if (raw || !isSpecial(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainValue(item as SerializedValue, raw)]));
  }
  const props = (record: Record<string, SerializedValue> = {}) =>
    Object.fromEntries(Object.entries(record).map(([key, item]) => [key, plainValue(item)]));
  const more = (missing: number) => (missing > 0 ? [`… ${missing} more`] : []);
  switch (value.$t) {
    case 'undefined':
      return undefined;
    case 'number':
      return value.v === '-0' ? 0 : value.v;
    case 'string':
      return `${value.v}… (${value.length.toLocaleString()} chars)`;
    case 'date':
      return value.v;
    case 'error':
      return { name: value.name, message: value.message, ...(value.stack ? { stack: value.stack } : {}), ...props(value.props) };
    case 'array':
      return [...value.items.map((item) => plainValue(item)), ...more(value.length - value.items.length)];
    case 'object':
      return value.more ? { ...props(value.props), '…': `${value.more} more` } : props(value.props);
    case 'map': {
      const entries = value.entries.map(([key, item]) => [typeof key === 'string' ? key : preview(key), plainValue(item)]);
      const missing = value.size - value.entries.length;
      return Object.fromEntries(missing > 0 ? [...entries, ['…', `${missing} more`]] : entries);
    }
    case 'set':
      return [...value.values.map((item) => plainValue(item)), ...more(value.size - value.values.length)];
    default:
      return preview(value);
  }
}

/** The full text of a value for the clipboard: strings as they are, errors with their stack, the rest as JSON. */
export function valueText(value: SerializedValue, raw = false): string {
  if (typeof value === 'string') return value;
  if (!raw && isSpecial(value) && value.$t === 'error') {
    const head = value.message ? `${value.name}: ${value.message}` : value.name;
    if (!value.stack) return head;
    return value.stack === head || value.stack.startsWith(`${head}\n`) ? value.stack : `${head}\n${value.stack}`;
  }
  const plain = plainValue(value, raw);
  return typeof plain === 'string' ? plain : (JSON.stringify(plain, null, 2) ?? String(plain));
}

/** The message line of a log entry, with printf-style `%s`/`%d`/`%o` substitutions applied. */
export function formatLogMessage(args: SerializedValue[]): string {
  let rest = args;
  const parts: string[] = [];
  const [first] = args;
  if (typeof first === 'string' && first.includes('%')) {
    const { text, used } = applyFormat(first, args.slice(1));
    parts.push(text);
    rest = args.slice(1 + used);
  }
  for (const arg of rest) parts.push(typeof arg === 'string' ? arg : preview(arg));
  return parts.join(' ');
}

/** React Native reports an unhandled promise rejection through `console.error`, with an error as the first argument. */
export function isUnhandledRejection(args: SerializedValue[]): boolean {
  const first = args[0];
  return (
    typeof first === 'object' &&
    first !== null &&
    isSpecial(first) &&
    first.$t === 'error' &&
    typeof first.message === 'string' &&
    first.message.startsWith('Uncaught (in promise')
  );
}

function applyFormat(format: string, args: SerializedValue[]): { text: string; used: number } {
  let used = 0;
  const text = format.replace(/%([sdifoOc%])/g, (match, spec: string) => {
    if (spec === '%') return '%';
    if (used >= args.length) return match;
    const arg = args[used++]!;
    switch (spec) {
      case 's':
        return typeof arg === 'string' ? arg : preview(arg);
      case 'd':
      case 'i':
        return String(Math.trunc(Number(typeof arg === 'object' ? Number.NaN : arg)));
      case 'f':
        return String(Number(typeof arg === 'object' ? Number.NaN : arg));
      case 'c':
        // CSS styling is not rendered.
        return '';
      default:
        return preview(arg);
    }
  });
  return { text, used };
}

export interface Matcher {
  test(text: string): boolean;
  invalid: boolean;
}

/** Plain text matches case-insensitively; `/pattern/flags` is a regular expression. */
export function makeMatcher(query: string): Matcher | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  // Only JavaScript's flags: a path such as /api/users is text.
  const regex = /^\/(.+)\/([dgimsuyv]*)$/.exec(trimmed);
  if (regex) {
    try {
      const pattern = new RegExp(regex[1]!, regex[2]!.replace(/[gy]/g, ''));
      return { test: (text) => pattern.test(text), invalid: false };
    } catch {
      return { test: () => true, invalid: true };
    }
  }
  const lower = trimmed.toLowerCase();
  return { test: (text) => text.toLowerCase().includes(lower), invalid: false };
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const LIBRARY_TITLES: Record<string, string> = {
  redux: 'Redux',
  zustand: 'Zustand',
  xstate: 'XState',
  mobx: 'MobX',
  'tanstack-query': 'TanStack Query',
  swr: 'SWR',
  context: 'React Context',
  riverpod: 'Riverpod',
  bloc: 'Bloc',
  watch: 'Watched',
} satisfies Record<StateLibrary, string>;

/** State libraries in the order stores are listed. */
export const STATE_LIBRARIES = Object.keys(LIBRARY_TITLES) as StateLibrary[];

export function libraryTitle(library: string): string {
  return LIBRARY_TITLES[library] ?? library;
}

/** `cart.items[1]`, `byId["42"].name`; `state` for the whole state. */
export function formatPath(path: StatePath): string {
  let text = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      text += `[${segment}]`;
      continue;
    }
    const key = formatKey(segment);
    text += key !== segment ? `[${key}]` : text ? `.${key}` : key;
  }
  return text || 'state';
}

/**
 * Reads a path written the way `formatPath` writes it; `''` is the whole state. Also takes `['key']` and
 * `[key]`. Undefined when the text is not a path.
 */
export function parsePath(text: string): StatePath | undefined {
  const source = text.trim();
  const path: StatePath = [];
  // True where a bare name may start: at the beginning and after a dot.
  let named = true;
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    if (char === '[') {
      const end = bracketEnd(source, i + 1);
      const key = end < 0 ? undefined : bracketKey(source.slice(i + 1, end).trim());
      if (key === undefined) return undefined;
      path.push(key);
      i = end + 1;
      named = false;
    } else if (char === '.') {
      if (named && path.length > 0) return undefined;
      named = true;
      i++;
    } else {
      if (!named) return undefined;
      let end = i;
      while (end < source.length && source[end] !== '.' && source[end] !== '[') end++;
      const name = source.slice(i, end);
      if (name.includes(']')) return undefined;
      path.push(name);
      i = end;
      named = false;
    }
  }
  return named && path.length > 0 ? undefined : path;
}

/** Index of the `]` closing a bracket whose content starts at `start`, past any quoted key. */
function bracketEnd(source: string, start: number): number {
  let i = start;
  while (source[i] === ' ') i++;
  const quote = source[i];
  if (quote === '"' || quote === "'") {
    i++;
    while (i < source.length && source[i] !== quote) i += source[i] === '\\' ? 2 : 1;
    if (i >= source.length) return -1;
  }
  return source.indexOf(']', i);
}

function bracketKey(inner: string): string | number | undefined {
  if (!inner) return undefined;
  if (inner.startsWith('"')) {
    try {
      const key: unknown = JSON.parse(inner);
      return typeof key === 'string' ? key : undefined;
    } catch {
      return undefined;
    }
  }
  if (inner.startsWith("'")) {
    return inner.length > 1 && inner.endsWith("'") ? inner.slice(1, -1).replace(/\\(.)/g, '$1') : undefined;
  }
  return /^-?\d+(\.\d+)?$/.test(inner) ? Number(inner) : inner;
}

export interface OpText {
  op: StateDiffOp['op'];
  path: string;
  prev?: string;
  value?: string;
}

/** Characters kept before the first difference when both sides of a change share a long start. */
const SHARED_CONTEXT = 7;

export function formatOp(op: StateDiffOp): OpText {
  const text: OpText = { op: op.op, path: formatPath(op.path) };
  if (op.op === 'set' && typeof op.prev === 'string' && typeof op.value === 'string') {
    // Long strings that differ near the end (timestamps, URLs) would otherwise show the same cut-off start twice.
    let shared = 0;
    while (shared < op.prev.length && op.prev[shared] === op.value[shared]) shared++;
    const cut = shared - SHARED_CONTEXT;
    if (cut >= 8) {
      text.prev = preview(`…${op.prev.slice(cut)}`);
      text.value = preview(`…${op.value.slice(cut)}`);
      return text;
    }
  }
  if (op.prev !== undefined) text.prev = preview(op.prev);
  if (op.value !== undefined) text.value = preview(op.value);
  return text;
}

/** The name of a change: its action, or for stores without action names, the paths it changed. */
export function stateChangeLabel(change: Pick<StateChangePayload, 'action' | 'cause' | 'ops' | 'opCount'>): {
  text: string;
  system: boolean;
} {
  if (change.action) {
    const type = String(change.action.type);
    return { text: type, system: type.startsWith('@@') };
  }
  if (change.cause === 'init') return { text: 'initial state', system: true };
  if (change.ops.length === 0) return { text: change.cause === 'external' ? 'external change' : 'no change', system: true };
  const paths = change.ops.slice(0, 3).map((op) => formatPath(op.path));
  const more = Math.max(change.opCount ?? 0, change.ops.length) - paths.length;
  return { text: `${paths.join(', ')}${more > 0 ? ` +${more}` : ''}`, system: false };
}
