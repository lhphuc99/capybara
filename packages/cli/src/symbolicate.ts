import { hostname, networkInterfaces } from 'node:os';
import { isSpecial, type CapybaraEvent, type SerializedValue, type SessionInfo, type SpecialValue } from '@capybara-devtools/protocol';
import { isLoopbackAddress } from './security.js';
import { mapWebStacks } from './source-maps.js';
import { formatFrame, parseFrame, type Frame } from './stack-frames.js';

type ErrorValue = Extract<SpecialValue, { $t: 'error' }> & { stack: string };

/** What Metro's `/symbolicate` answers for a frame; `file` stays the bundle URL when it found nothing. */
interface MappedFrame {
  file?: unknown;
  lineNumber?: unknown;
  column?: unknown;
  methodName?: unknown;
  /** Set on React Native's own frames, which LogBox hides. */
  collapse?: unknown;
}

/** React Native's source URLs are jsc-safe: the query comes after `//&` instead of `?`. */
const BUNDLE = /\.bundle(?:$|[?#]|\/\/&)/;
/** Android emulators (and Genymotion) reach the host's loopback at these addresses. */
const EMULATOR_HOSTS = ['10.0.2.2', '10.0.3.2'];

/** The origin of a web app's dev server on this machine, whose scripts come with source maps. */
export function localWebOrigin(info: SessionInfo): string | undefined {
  if (info.platform !== 'web' || typeof info.url !== 'string') return undefined;
  try {
    const url = new URL(info.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return isLocal(url.hostname, localHosts()) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Whether some logged error has a stack worth mapping: into a Metro bundle, or into the web app's own dev server. */
export function needsSymbolication(events: readonly CapybaraEvent[], webOrigin?: string): boolean {
  return errorStacks(events, (stack) => BUNDLE.test(stack) || (webOrigin !== undefined && stack.includes(webOrigin))).length > 0;
}

/**
 * Rewrites the stacks of logged errors, in place, to point at source files. React Native stacks point into the
 * bundle Metro served (`index.bundle?…:86171:28`); Metro's `/symbolicate`, which LogBox uses too, maps them. Only
 * a Metro on this machine is asked, since Capybara reaches it on localhost. Web stacks are mapped through the
 * source maps of the page's dev server (`webOrigin`). Frames nothing maps, and stacks not mapped in time, stay
 * as they were.
 */
export async function symbolicateEvents(
  events: readonly CapybaraEvent[],
  options: { timeout?: number; signal?: AbortSignal; webOrigin?: string } = {},
): Promise<void> {
  const { webOrigin } = options;
  const metro = errorStacks(events, (stack) => BUNDLE.test(stack));
  const web = webOrigin === undefined ? [] : errorStacks(events, (stack) => stack.includes(webOrigin));
  if (metro.length === 0 && web.length === 0) return;
  const timeout = AbortSignal.timeout(options.timeout ?? 5_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  await Promise.all([
    metro.length > 0 ? symbolicateBundles(metro, signal) : undefined,
    webOrigin !== undefined && web.length > 0 ? mapWebStacks(web, webOrigin, signal).catch(() => {}) : undefined,
  ]);
}

async function symbolicateBundles(stacks: ErrorValue[], signal: AbortSignal): Promise<void> {
  const local = localHosts();
  const byPort = new Map<number, Frame[]>();
  const collapsed = new Map<string[], Set<number>>();
  const rewritten = stacks.map((error) => {
    const lines = error.stack.split('\n');
    collapsed.set(lines, new Set());
    lines.forEach((text, index) => {
      const frame = parseFrame(text, lines, index);
      const port = frame && BUNDLE.test(frame.url) ? metroPort(frame.url, local) : undefined;
      if (!frame || port === undefined) return;
      const frames = byPort.get(port) ?? [];
      frames.push(frame);
      byPort.set(port, frames);
    });
    return { error, lines };
  });
  if (byPort.size === 0) return;
  await Promise.all(
    [...byPort].map(async ([port, frames]) => {
      const mapped = await askMetro(port, frames, signal).catch(() => []);
      frames.forEach((frame, i) => {
        const text = formatMapped(frame, mapped[i]);
        if (text) frame.lines[frame.index] = text;
        if (mapped[i]?.collapse === true) collapsed.get(frame.lines)?.add(frame.index);
      });
    }),
  );
  for (const { error, lines } of rewritten) {
    error.stack = (error.name === 'Trace' ? withoutConsoleFrames(lines, collapsed.get(lines) ?? new Set()) : lines).join('\n');
  }
}

/**
 * Hermes starts a console.trace() stack inside the console wrappers of React Native and React DevTools, which
 * Metro marks to collapse. They go, as LogBox hides them, unless nothing else is left.
 */
function withoutConsoleFrames(lines: string[], collapsed: Set<number>): string[] {
  let first = 1;
  while (collapsed.has(first)) first++;
  return first > 1 && first < lines.length ? [lines[0]!, ...lines.slice(first)] : lines;
}

function errorStacks(events: readonly CapybaraEvent[], test: (stack: string) => boolean): ErrorValue[] {
  const found: ErrorValue[] = [];
  for (const event of events) {
    const args: unknown = event.kind === 'log' ? event.payload?.args : undefined;
    if (Array.isArray(args)) collect(args, found, test);
  }
  return found;
}

/** Payloads arrive unchecked, so every shape is tested before it is walked. */
function collect(value: unknown, found: ErrorValue[], test: (stack: string) => boolean): void {
  if (value === null || typeof value !== 'object') return;
  const each = (items: unknown) => {
    if (Array.isArray(items)) for (const item of items) collect(item, found, test);
  };
  const props = (record: unknown) => {
    if (record && typeof record === 'object') each(Object.values(record));
  };
  if (Array.isArray(value)) return each(value);
  if (!isSpecial(value as SerializedValue)) return props(value);
  const special = value as Record<string, unknown>;
  switch (special.$t) {
    case 'error':
      if (typeof special.stack === 'string' && test(special.stack)) found.push(special as ErrorValue);
      return props(special.props);
    case 'array':
      return each(special.items);
    case 'object':
      return props(special.props);
    case 'map':
      if (Array.isArray(special.entries)) for (const entry of special.entries) each(entry);
      return;
    case 'set':
      return each(special.values);
  }
}

/** Names a bundle URL may use for this machine: the app found Metro at one of them. */
function localHosts(): Set<string> {
  const names = new Set(['localhost', ...EMULATOR_HOSTS, hostname().toLowerCase(), `${hostname().toLowerCase()}.local`]);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) names.add(entry.address.toLowerCase());
  }
  return names;
}

function isLocal(hostname: string, local: Set<string>): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return local.has(host) || isLoopbackAddress(host);
}

function metroPort(url: string, local: Set<string>): number | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!isLocal(parsed.hostname, local)) return undefined;
  return Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
}

async function askMetro(port: number, frames: Frame[], signal: AbortSignal): Promise<MappedFrame[]> {
  const response = await fetch(`http://localhost:${port}/symbolicate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Metro takes 0-based columns, as React Native's own parseErrorStack sends them.
    body: JSON.stringify({
      stack: frames.map((frame) => ({ file: frame.url, lineNumber: frame.line, column: frame.column - 1, methodName: frame.name })),
    }),
    signal,
  });
  if (!response.ok) return [];
  const body = (await response.json()) as { stack?: unknown } | null;
  return Array.isArray(body?.stack) && body.stack.length === frames.length ? (body.stack as MappedFrame[]) : [];
}

function formatMapped(frame: Frame, mapped: MappedFrame | undefined): string | undefined {
  const { file, lineNumber, column, methodName } = mapped ?? {};
  if (typeof file !== 'string' || file.includes('://') || typeof lineNumber !== 'number' || typeof column !== 'number') {
    return undefined;
  }
  return formatFrame(frame, file, lineNumber, column + 1, typeof methodName === 'string' && methodName ? methodName : frame.name);
}
