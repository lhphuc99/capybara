import {
  formatLogMessage,
  isExpandable,
  isSpecial,
  valueText,
  type LogSource,
  type Platform,
  type SerializedValue,
  type SessionInfo,
} from '@capybara-devtools/protocol';
import type { LogEntry, NetworkEntry } from './store';

export {
  formatBytes,
  formatKey,
  formatLogMessage,
  isExpandable,
  isSpecial,
  makeMatcher,
  plainValue,
  preview,
  valueText,
  type Matcher,
} from '@capybara-devtools/protocol';

export const LOG_SOURCE_LABELS: Record<LogSource, string | null> = {
  console: null,
  api: 'api',
  uncaught: 'uncaught',
  unhandledrejection: 'unhandled rejection',
};

/** A log entry as copied text: the line as the list shows it, then each object or error in full. */
export function logEntryText(entry: LogEntry): string {
  const source = LOG_SOURCE_LABELS[entry.source];
  const head = `${formatTime(entry.ts)} ${entry.level.toUpperCase().padEnd(5)} ${source ? `(${source}) ` : ''}${formatLogMessage(entry.args)}`;
  const details = entry.args
    .filter((arg) => isExpandable(arg) || (isSpecial(arg) && arg.$t === 'string'))
    .map((arg) => valueText(arg).replace(/^/gm, '  '));
  return [head, ...details].join('\n');
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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

/**
 * What the Fetch/XHR filter shows. React Native's fetch is an XHR underneath, and through Metro Expo
 * reports both without saying which (`other`), so the two are one filter, as in Chrome's DevTools.
 */
export function isFetchOrXhr(initiator: string): boolean {
  return initiator === 'fetch' || initiator === 'xhr' || initiator === 'other';
}

/** Resolves false when neither the Clipboard API nor the older copy command worked. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; LAN addresses over plain HTTP are not one.
    const area = document.createElement('textarea');
    area.value = text;
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  }
}
