import {
  formatBytes,
  type BodyPreview,
  type NetworkDiagnosis,
  type NetworkEntry,
  type SocketMessage,
} from '@capybara-devtools/protocol';
import type { Redactor } from './mcp-redact.js';
import { clock, duration, indent, parseJson, searchMatcher, truncate } from './mcp-text.js';

export interface NetworkQuery {
  search?: string;
  method?: string;
  status?: string;
  errors?: boolean;
  type?: NetworkEntry['initiator'];
  minDuration?: number;
  after?: number;
  before?: number;
}

export function filterRequests(requests: NetworkEntry[], query: NetworkQuery, redact: Redactor): NetworkEntry[] {
  const matcher = searchMatcher(query.search);
  const status = statusFilter(query.status);
  return requests.filter((entry) => {
    if (query.method && entry.method.toUpperCase() !== query.method.toUpperCase()) return false;
    if (query.type && entry.initiator !== query.type) return false;
    if (query.errors && !isError(entry)) return false;
    if (status && !status(entry)) return false;
    if (query.minDuration !== undefined && (entry.duration ?? 0) < query.minDuration) return false;
    if (query.after !== undefined && entry.seq <= query.after) return false;
    if (query.before !== undefined && entry.seq >= query.before) return false;
    return !matcher || matcher.test(`${entry.method} ${redact.url(entry.url)}`);
  });
}

function isError(entry: NetworkEntry): boolean {
  return entry.state === 'failed' || (!entry.socket && (entry.status ?? 0) >= 400);
}

function statusFilter(spec: string | undefined): ((entry: NetworkEntry) => boolean) | undefined {
  const value = spec?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === 'failed') return (entry) => entry.state === 'failed';
  if (value === 'pending') return (entry) => entry.state === 'pending';
  const range = /^([1-5])xx$/.exec(value);
  // A socket's 101 is not a response status anyone filters for.
  if (range) return (entry) => !entry.socket && Math.floor((entry.status ?? 0) / 100) === Number(range[1]);
  if (/^\d{3}$/.test(value)) return (entry) => !entry.socket && entry.status === Number(value);
  throw new Error(`Unknown status filter "${spec}". Use a status such as 404, a class such as 4xx or 5xx, "failed" or "pending".`);
}

export function requestLine(entry: NetworkEntry, redact: Redactor): string {
  const columns = [
    entry.id,
    clock(entry.ts),
    entry.method.padEnd(6),
    statusLabel(entry).padEnd(8),
    duration(entry.duration).padStart(8),
    entry.initiator.padEnd(9),
    redact.url(entry.url),
  ];
  return columns.join('  ') + requestNote(entry);
}

const SOCKET_STATES: Record<NetworkEntry['state'], string> = { pending: 'connecting', open: 'open', done: 'closed', failed: 'failed' };

function statusLabel(entry: NetworkEntry): string {
  if (entry.socket) {
    const state = SOCKET_STATES[entry.state];
    return entry.socket.closeCode !== undefined ? `${state} ${entry.socket.closeCode}` : state;
  }
  if (entry.state === 'failed') return entry.failure?.aborted ? 'aborted' : entry.failure?.timeout ? 'timeout' : 'failed';
  return entry.status === undefined ? 'pending' : String(entry.status);
}

function requestNote(entry: NetworkEntry): string {
  if (entry.socket) {
    const { closeReason } = entry.socket;
    const parts = [`${entry.socket.messages.length} messages`, entry.error, closeReason === entry.error ? undefined : closeReason];
    return `  ← ${parts.filter(Boolean).join(', ')}`;
  }
  if (entry.state === 'failed') return `  ← ${entry.error}${entry.failure?.cause ? ` [${entry.failure.cause}]` : ''}`;
  return '';
}

export type BodyMode = 'none' | 'preview' | 'full';

const BODY_PREVIEW = 4_000;

export function requestDetail(entry: NetworkEntry, redact: Redactor, body: BodyMode): string {
  const lines = [`${entry.method} ${redact.url(entry.url)}`];
  const status = entry.socket
    ? statusLabel(entry)
    : entry.state === 'failed'
      ? statusLabel(entry)
      : entry.status === undefined
        ? 'pending'
        : `${entry.status}${entry.statusText ? ` ${entry.statusText}` : ''}`;
  lines.push(`Status: ${status} · ${duration(entry.duration)} · ${entry.initiator} · started ${clock(entry.ts)} · request id ${entry.id}`);
  if (!entry.socket && entry.state === 'failed') {
    const cause = entry.failure?.cause ? ` (${entry.failure.cause})` : '';
    lines.push(`Failed: ${entry.error}${cause}${entry.failure?.credentials ? '; the request sent cookies' : ''}.`);
    if (entry.failure?.cause === 'cross-origin') lines.push('Call diagnose_request with this id to find out why.');
  }
  if (entry.socket) {
    const socket = entry.socket;
    if (socket.protocol) lines.push(`Subprotocol: ${socket.protocol}`);
    if (entry.error) lines.push(`Error: ${entry.error}`);
    if (socket.existing) lines.push('Already open when Capybara attached, so earlier messages are missing.');
    lines.push(`${socket.messages.length} messages; call get_websocket with this id to read them.`);
    return lines.join('\n');
  }
  lines.push('', 'Request headers:', ...headerLines(redact.headers(entry.requestHeaders)));
  if (body !== 'none') lines.push('', `Request body${bodyMeta(entry.requestBody)}:`, indent(bodyText(entry.requestBody, redact, body), '  '));
  if (entry.responseHeaders) lines.push('', 'Response headers:', ...headerLines(redact.headers(entry.responseHeaders)));
  if (body !== 'none' && (entry.responseHeaders || entry.responseBody)) {
    lines.push('', `Response body${bodyMeta(entry.responseBody)}:`, indent(bodyText(entry.responseBody, redact, body), '  '));
  }
  return lines.join('\n');
}

function headerLines(headers: Record<string, string>): string[] {
  const entries = Object.entries(headers);
  return entries.length === 0 ? ['  (none set by the app)'] : entries.map(([name, value]) => `  ${name}: ${value}`);
}

function bodyMeta(body: BodyPreview | undefined): string {
  if (!body) return '';
  const parts = [body.contentType, body.size === undefined ? undefined : formatBytes(body.size)].filter(Boolean);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function bodyText(body: BodyPreview | undefined, redact: Redactor, mode: BodyMode): string {
  if (!body) return '(none)';
  if (body.text === undefined) return body.summary ?? `(${body.kind})`;
  const parsed = parseJson(body.text);
  const text = parsed.ok ? JSON.stringify(redact.json(parsed.value), null, 2) : redact.text(body.text);
  const cut = mode === 'preview' ? truncate(text, BODY_PREVIEW) : text;
  return body.truncated ? `${cut}\n(the app captured only the beginning of this body)` : cut;
}

export interface SocketQuery {
  direction?: 'sent' | 'received';
  search?: string;
  after?: number;
}

export function filterMessages(messages: SocketMessage[], query: SocketQuery, redact: Redactor): SocketMessage[] {
  const matcher = searchMatcher(query.search);
  return messages.filter((message) => {
    if (query.direction && message.direction !== query.direction) return false;
    if (query.after !== undefined && message.seq <= query.after) return false;
    return !matcher || matcher.test(messageText(message, redact));
  });
}

export function messageLine(message: SocketMessage, redact: Redactor): string {
  const arrow = message.direction === 'sent' ? '→ sent    ' : '← received';
  return `#${message.seq} ${clock(message.ts)} ${arrow} ${truncate(messageText(message, redact), 600)}`;
}

function messageText(message: SocketMessage, redact: Redactor): string {
  const { data } = message;
  if (data.text === undefined) return `${data.summary ?? data.kind}${data.size === undefined ? '' : ` (${formatBytes(data.size)})`}`;
  return redact.text(data.text);
}

export function diagnosisText(entry: NetworkEntry, diagnosis: NetworkDiagnosis, redact: Redactor): string {
  const marks = { pass: '✓', fail: '✗', info: '•' } as const;
  const lines = [
    `${entry.method} ${redact.url(entry.url)}`,
    `Verdict: ${diagnosis.verdict}. ${diagnosis.summary}`,
  ];
  if (diagnosis.checks.length > 0) {
    lines.push('', 'Checks:', ...diagnosis.checks.map((check) => `  ${marks[check.outcome]} ${check.label}: ${check.detail}`));
  }
  if (diagnosis.sent.length > 0) {
    lines.push('', 'Sent from this computer, without the app\'s cookies or Authorization header:', ...diagnosis.sent.map((line) => `  ${redact.url(line)}`));
  }
  return lines.join('\n');
}
