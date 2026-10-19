import { hostname, networkInterfaces } from 'node:os';
import { isSpecial, type CapybaraEvent, type SerializedValue, type SpecialValue } from '@capybara-devtools/protocol';
import { isLoopbackAddress } from './security.js';

type ErrorValue = Extract<SpecialValue, { $t: 'error' }> & { stack: string };

/** One line of a stack that points into a Metro bundle. */
interface Frame {
  lines: string[];
  index: number;
  /** `at` for Hermes and V8 (`    at fn (url:1:2)`), `@` for JSC, Safari and Firefox (`fn@url:1:2`). */
  style: 'at' | '@';
  indent: string;
  name: string | undefined;
  url: string;
  line: number;
  /** 1-based, as stacks print it. */
  column: number;
}

/** What Metro's `/symbolicate` answers for a frame; `file` stays the bundle URL when it found nothing. */
interface MappedFrame {
  file?: unknown;
  lineNumber?: unknown;
  column?: unknown;
  methodName?: unknown;
}

const AT_FRAME = /^(\s*)at (?:(.+?) \()?(https?:\/\/\S+?):(\d+):(\d+)\)?$/;
const JSC_FRAME = /^(\s*)(.*?)@(https?:\/\/\S+?):(\d+):(\d+)$/;
/** React Native's source URLs are jsc-safe: the query comes after `//&` instead of `?`. */
const BUNDLE = /\.bundle(?:$|[?#]|\/\/&)/;
/** Android emulators (and Genymotion) reach the host's loopback at these addresses. */
const EMULATOR_HOSTS = ['10.0.2.2', '10.0.3.2'];

/** Whether some logged error has a stack into a Metro bundle, so is worth a trip to Metro. */
export function hasBundleFrames(events: readonly CapybaraEvent[]): boolean {
  return bundleStacks(events).length > 0;
}

/**
 * React Native stacks point into the bundle Metro served (`index.bundle?…:86171:28`). Metro's
 * `/symbolicate`, which LogBox uses too, maps them back to source files; this rewrites the stacks of
 * logged errors with its answer, in place. Only a Metro on this machine is asked, since Capybara
 * reaches it on localhost. Frames it cannot map, and stacks it does not answer for in time, stay as
 * they were.
 */
export async function symbolicateEvents(
  events: readonly CapybaraEvent[],
  options: { timeout?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const stacks = bundleStacks(events);
  if (stacks.length === 0) return;
  const local = localHosts();
  const byPort = new Map<number, Frame[]>();
  const rewritten = stacks.map((error) => {
    const lines = error.stack.split('\n');
    lines.forEach((text, index) => {
      const frame = parseFrame(text, lines, index);
      const port = frame && metroPort(frame.url, local);
      if (!frame || port === undefined) return;
      const frames = byPort.get(port) ?? [];
      frames.push(frame);
      byPort.set(port, frames);
    });
    return { error, lines };
  });
  if (byPort.size === 0) return;

  const timeout = AbortSignal.timeout(options.timeout ?? 5_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  await Promise.all(
    [...byPort].map(async ([port, frames]) => {
      const mapped = await askMetro(port, frames, signal).catch(() => []);
      frames.forEach((frame, i) => {
        const text = formatFrame(frame, mapped[i]);
        if (text) frame.lines[frame.index] = text;
      });
    }),
  );
  for (const { error, lines } of rewritten) error.stack = lines.join('\n');
}

function bundleStacks(events: readonly CapybaraEvent[]): ErrorValue[] {
  const found: ErrorValue[] = [];
  for (const event of events) {
    const args: unknown = event.kind === 'log' ? event.payload?.args : undefined;
    if (Array.isArray(args)) collect(args, found);
  }
  return found;
}

/** Payloads arrive unchecked, so every shape is tested before it is walked. */
function collect(value: unknown, found: ErrorValue[]): void {
  if (value === null || typeof value !== 'object') return;
  const each = (items: unknown) => {
    if (Array.isArray(items)) for (const item of items) collect(item, found);
  };
  const props = (record: unknown) => {
    if (record && typeof record === 'object') each(Object.values(record));
  };
  if (Array.isArray(value)) return each(value);
  if (!isSpecial(value as SerializedValue)) return props(value);
  const special = value as Record<string, unknown>;
  switch (special.$t) {
    case 'error':
      if (typeof special.stack === 'string' && BUNDLE.test(special.stack)) found.push(special as ErrorValue);
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

function parseFrame(text: string, lines: string[], index: number): Frame | undefined {
  const at = AT_FRAME.exec(text);
  const match = at ?? JSC_FRAME.exec(text);
  if (!match || !BUNDLE.test(match[3]!)) return undefined;
  return {
    lines,
    index,
    style: at ? 'at' : '@',
    indent: match[1]!,
    name: match[2] || undefined,
    url: match[3]!,
    line: Number(match[4]),
    column: Number(match[5]),
  };
}

/** Names a bundle URL may use for this machine: the app found Metro at one of them. */
function localHosts(): Set<string> {
  const names = new Set(['localhost', ...EMULATOR_HOSTS, hostname().toLowerCase(), `${hostname().toLowerCase()}.local`]);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) names.add(entry.address.toLowerCase());
  }
  return names;
}

function metroPort(url: string, local: Set<string>): number | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!local.has(host) && !isLoopbackAddress(host)) return undefined;
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

function formatFrame(frame: Frame, mapped: MappedFrame | undefined): string | undefined {
  const { file, lineNumber, column, methodName } = mapped ?? {};
  if (typeof file !== 'string' || file.includes('://') || typeof lineNumber !== 'number' || typeof column !== 'number') {
    return undefined;
  }
  const name = typeof methodName === 'string' && methodName ? methodName : frame.name;
  const location = `${file}:${lineNumber}:${column + 1}`;
  if (frame.style === '@') return `${frame.indent}${name ?? ''}@${location}`;
  return `${frame.indent}at ${name ? `${name} (${location})` : location}`;
}
