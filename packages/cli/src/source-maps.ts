import { AnyMap, originalPositionFor, type TraceMap } from '@jridgewell/trace-mapping';
import { formatFrame, parseFrame, type Frame } from './stack-frames.js';

/** Scripts and the source maps they point to are skipped past this size. */
const MAX_BYTES = 20 * 1024 * 1024;
/** Dev servers serve new code at the same URL after an edit, so a map is kept only this long. */
const CACHE_MS = 30_000;
const CACHE_SIZE = 50;
/**
 * Only script files of the page's own dev server are fetched, since any app connected to Capybara could put a
 * URL in a stack: Vite's modules (`/src/App.tsx`), Next.js chunks (`/_next/static/chunks/…js`) and the like.
 */
const SCRIPT = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i;

const maps = new Map<string, { at: number; map: Promise<TraceMap | undefined> }>();

/**
 * Web stacks point into what the dev server served: Vite's transformed modules, Next.js chunks. This maps
 * their frames back to the source files through the source maps the dev server gives with them, in place.
 * Frames of other origins, and frames no map covers, stay as they were.
 */
export async function mapWebStacks(stacks: Array<{ stack: string }>, origin: string, signal: AbortSignal): Promise<void> {
  const frames: Frame[] = [];
  const rewritten = stacks.map((error) => {
    const lines = error.stack.split('\n');
    lines.forEach((text, index) => {
      const frame = parseFrame(text, lines, index);
      if (frame && fetchable(frame.url, origin)) frames.push(frame);
    });
    return { error, lines };
  });
  if (frames.length === 0) return;
  await Promise.all(
    frames.map(async (frame) => {
      const map = await mapOf(frame.url, origin, signal);
      if (!map) return;
      const position = originalPositionFor(map, { line: frame.line, column: frame.column - 1 });
      if (position.source === null || position.line === null || position.column === null) return;
      frame.lines[frame.index] = formatFrame(frame, displayPath(position.source, origin), position.line, position.column + 1, position.name ?? frame.name);
    }),
  );
  for (const { error, lines } of rewritten) error.stack = lines.join('\n');
}

function fetchable(url: string, origin: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === origin && SCRIPT.test(parsed.pathname);
  } catch {
    return false;
  }
}

function mapOf(url: string, origin: string, signal: AbortSignal): Promise<TraceMap | undefined> {
  const now = Date.now();
  const cached = maps.get(url);
  if (cached && now - cached.at < CACHE_MS) return cached.map;
  const map = loadMap(url, origin, signal).catch(() => undefined);
  maps.delete(url);
  maps.set(url, { at: now, map });
  // The oldest go first.
  while (maps.size > CACHE_SIZE) maps.delete(maps.keys().next().value!);
  return map;
}

async function loadMap(url: string, origin: string, signal: AbortSignal): Promise<TraceMap | undefined> {
  const script = await fetchText(url, signal);
  if (script === undefined) return undefined;
  const reference = [...script.text.matchAll(/\/\/[#@] sourceMappingURL=(\S+)/g)].at(-1)?.[1] ?? script.header;
  if (!reference) return undefined;
  if (reference.startsWith('data:')) return new AnyMap(decodeDataUrl(reference), url);
  const mapUrl = new URL(reference, url);
  // A map elsewhere would be a request Capybara makes for the page; it stays on the page's dev server.
  if (mapUrl.origin !== origin) return undefined;
  const map = await fetchText(mapUrl.href, signal);
  return map === undefined ? undefined : new AnyMap(map.text, mapUrl.href);
}

async function fetchText(url: string, signal: AbortSignal): Promise<{ text: string; header?: string } | undefined> {
  const response = await fetch(url, { signal, redirect: 'error' });
  if (!response.ok) return undefined;
  if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) return undefined;
  const text = await response.text();
  if (text.length > MAX_BYTES) return undefined;
  return { text, header: response.headers.get('sourcemap') ?? response.headers.get('x-sourcemap') ?? undefined };
}

function decodeDataUrl(url: string): string {
  const comma = url.indexOf(',');
  const meta = url.slice(5, comma);
  const data = url.slice(comma + 1);
  return meta.includes(';base64') ? Buffer.from(data, 'base64').toString('utf8') : decodeURIComponent(data);
}

/** A source as people read it: `src/App.tsx` on the dev server, a file path, or the project path of a bundler URL. */
function displayPath(source: string, origin: string): string {
  if (source.startsWith(`${origin}/`)) return source.slice(origin.length + 1).replace(/[?#].*$/, '');
  if (source.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(source).pathname);
    } catch {
      return source;
    }
  }
  const bundler = /^(?:webpack:\/\/[^/]*\/|turbopack:\/\/\/(?:\[project\]\/)?)(?:\.\/)?(.+)$/.exec(source);
  return bundler ? bundler[1]! : source;
}
