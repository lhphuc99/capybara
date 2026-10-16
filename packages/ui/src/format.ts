import type { Platform, SerializedValue, SessionInfo, SpecialValue } from '@capybara/protocol';
import type { NetworkEntry } from './store';

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
      return `${v.name}: ${v.message}`;
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
  const regex = /^\/(.+)\/([a-z]*)$/i.exec(trimmed);
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

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function splitUrl(url: string): { path: string; host: string } {
  try {
    const parsed = new URL(url);
    return { path: `${parsed.pathname}${parsed.search}`, host: parsed.host };
  } catch {
    return { path: url, host: '' };
  }
}

export function statusTone(entry: NetworkEntry): 'ok' | 'redirect' | 'error' | 'pending' {
  if (entry.state === 'pending') return 'pending';
  if (entry.state === 'failed' || (entry.status ?? 0) >= 400) return 'error';
  if ((entry.status ?? 0) >= 300) return 'redirect';
  return 'ok';
}

export function responseSize(entry: NetworkEntry): number | undefined {
  if (entry.socket) return entry.socket.bytes;
  if (entry.responseBody?.size !== undefined) return entry.responseBody.size;
  const header = findHeader(entry.responseHeaders, 'content-length');
  return header === undefined ? undefined : Number(header);
}

export function findHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) if (key.toLowerCase() === target) return headers[key];
  return undefined;
}

export function toCurl(entry: NetworkEntry): string {
  const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
  const parts = [`curl ${quote(entry.url)}`];
  if (entry.method !== 'GET') parts.push(`-X ${entry.method}`);
  for (const [name, value] of Object.entries(entry.requestHeaders)) parts.push(`-H ${quote(`${name}: ${value}`)}`);
  const body = entry.requestBody;
  if (body?.text !== undefined && body.kind === 'text') parts.push(`--data-raw ${quote(body.text)}`);
  return parts.join(' \\\n  ');
}

const ENGINE_IO_PACKETS = ['open', 'close', 'ping', 'pong', 'message', 'upgrade', 'noop'];
const SOCKET_IO_PACKETS = ['connect', 'disconnect', 'event', 'ack', 'connect error', 'binary event', 'binary ack'];

/**
 * Names a socket.io (engine.io v4) text frame, e.g. `42["chat",{"text":"hi"}]` is event "chat".
 * `payload` is the JSON that follows: the event's arguments, or the packet's data.
 */
export function decodeSocketIo(text: string): { label: string; payload?: string } | undefined {
  const engine = ENGINE_IO_PACKETS[Number(text[0])];
  if (!engine || !/^\d/.test(text)) return undefined;
  if (engine !== 'message') return { label: engine, payload: text.slice(1) || undefined };
  // 4<type>[<attachments>-][<namespace>,][<ack id>][<data>]
  const match = /^4([0-6])(?:\d+-)?(\/[^,]*,)?(\d+)?([\s\S]*)$/.exec(text);
  if (!match) return { label: 'message', payload: text.slice(1) || undefined };
  const [, type, namespace, ack, data] = match;
  const parts = [SOCKET_IO_PACKETS[Number(type)]!];
  let payload = data || undefined;
  if ((type === '2' || type === '5') && data) {
    try {
      const args = JSON.parse(data) as unknown;
      if (Array.isArray(args) && typeof args[0] === 'string') {
        parts.push(JSON.stringify(args[0]));
        payload = args.length > 1 ? JSON.stringify(args.length === 2 ? args[1] : args.slice(1)) : undefined;
      }
    } catch {
      // not JSON; keep the raw data
    }
  }
  if (namespace && namespace !== '/,') parts.push(`in ${namespace.slice(0, -1)}`);
  if (ack) parts.push(`#${ack}`);
  return { label: parts.join(' '), payload };
}

export function parseJson(text: string): { ok: true; value: SerializedValue } | { ok: false } {
  const trimmed = text.trim();
  if (!trimmed || !'{["'.includes(trimmed[0]!)) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) as SerializedValue };
  } catch {
    return { ok: false };
  }
}

const PLATFORM_LABELS: Record<Platform, string> = {
  web: 'Web',
  ios: 'iOS',
  android: 'Android',
  windows: 'Windows',
  macos: 'macOS',
  unknown: 'App',
};

export function platformLabel(platform: Platform): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

const BROWSERS: Array<[RegExp, string]> = [
  [/Edg\/(\d+)/, 'Edge'],
  [/OPR\/(\d+)/, 'Opera'],
  [/Firefox\/(\d+)/, 'Firefox'],
  [/Chrome\/(\d+)/, 'Chrome'],
  [/Version\/(\d+).*Safari/, 'Safari'],
];

export function describeSession(info: SessionInfo): string {
  if (info.platform === 'web') {
    let browser = 'Browser';
    for (const [pattern, name] of BROWSERS) {
      const match = info.userAgent ? pattern.exec(info.userAgent) : null;
      if (match) {
        browser = `${name} ${match[1]}`;
        break;
      }
    }
    return [browser, info.url ? splitUrl(info.url).host : undefined].filter(Boolean).join(' · ');
  }
  return [info.device?.model, info.device?.osVersion, info.device?.isEmulator ? 'emulator' : undefined, info.runtime]
    .filter(Boolean)
    .join(' · ');
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs a secure context; LAN addresses over plain HTTP are not one.
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}
