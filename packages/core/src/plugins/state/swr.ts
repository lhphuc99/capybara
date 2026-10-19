import type { StateEntrySummary } from '@capybara-devtools/protocol';
import { errorMessage } from '../../utils.js';
import type { StoreDriver } from './index.js';
import { register, unregister } from './registry.js';

/** What Capybara uses of an SWR cache. SWR's `Cache` and a `Map` both fit. */
export interface SWRCacheLike {
  keys(): IterableIterator<string>;
  get(key: string): any;
  set(key: string, value: any): void;
  delete(key: string): void;
}

/** A cache and the `mutate` bound to it, as `useSWRConfig()` and `SWRConfig.defaultValue` hold them. */
export interface SWRHandle {
  cache: SWRCacheLike;
  /** Runs the revalidate, clear and reset commands. */
  mutate?: (...args: any[]) => unknown;
  unload?: unknown;
}

export interface WatchSWROptions {
  /** Names the cache in the State tab. Defaults to "default" for SWR's own cache, else "cache #1", "cache #2"… */
  name?: string;
}

/** SWR's hook, as a middleware receives it. */
type SWRHookLike = (key: any, fetcher: any, config: any) => any;

interface Watch {
  mutate?: (...args: any[]) => unknown;
  untrack: () => void;
}

/** Keys listed per cache. SWR never evicts, so a long session can hold many more. */
const MAX_KEYS = 1_000;
/** How long a revalidate waits for its fetch before answering anyway; the UI gives up on a command after 15 s. */
const REVALIDATE_WAIT = 10_000;
const NO_HOOK = 'No mounted hook fetches this key, so nothing was revalidated';
const NO_MUTATE = 'Capybara has no mutate() for this cache yet: add swrMiddleware to the SWRConfig that creates it';

/** Caches already registered, so the middleware, which runs on every render, only looks one up. */
const watched = new WeakMap<object, Watch>();
let unnamed = 0;
const noop = () => {};

/**
 * Shows an SWR cache in the State tab. Pass `SWRConfig` for SWR's default cache, the result of
 * `useSWRConfig()`, or `{ cache, mutate }`. Watching a cache again only fills in a `mutate` it lacked.
 * Returns a function that stops showing it. Does nothing where there is no `window` (server rendering).
 */
export function watchSWR(target: SWRHandle | { defaultValue: SWRHandle }, options: WatchSWROptions = {}): () => void {
  if (typeof window === 'undefined') return noop;
  try {
    const defaults = (target as { defaultValue?: SWRHandle }).defaultValue;
    const handle = (defaults ?? target) as SWRHandle;
    const cache = handle.cache;
    if (!isCache(cache)) return noop;
    const mutate = typeof handle.mutate === 'function' ? handle.mutate : undefined;
    const known = watched.get(cache);
    if (known) {
      known.mutate ??= mutate;
      return known.untrack;
    }
    const watch: Watch = { mutate, untrack: noop };
    const label = options.name ?? (defaults ? 'default' : `cache #${++unnamed}`);
    const id = register(swrDriver(cache, label, watch), cache);
    if (id === undefined) return noop;
    watch.untrack = () => {
      if (watched.get(cache) === watch) watched.delete(cache);
      unregister(id);
    };
    watched.set(cache, watch);
    return watch.untrack;
  } catch {
    return noop;
  }
}

/**
 * Watches the cache of each hook rendered under it: `<SWRConfig value={{ use: [swrMiddleware] }}>`.
 * For an SWRConfig with its own `provider`, as React Native apps have; it also hands over the `mutate`
 * that commands need, which `swrProvider` cannot reach.
 */
export function swrMiddleware(useSWRNext: SWRHookLike): SWRHookLike {
  return (key, fetcher, config) => {
    if (config) watchSWR(config);
    return useSWRNext(key, fetcher, config);
  };
}

/**
 * Watches the cache an SWRConfig `provider` makes: `provider: swrProvider(() => new Map())`. Without
 * `inner`, watches the parent cache. SWR creates the cache's `mutate` only after the provider returns,
 * so add `swrMiddleware` too for the revalidate, clear and reset commands.
 */
export function swrProvider(
  inner?: (parent: SWRCacheLike) => SWRCacheLike,
  options?: WatchSWROptions,
): (parent: SWRCacheLike) => SWRCacheLike {
  return (parent) => {
    const cache = inner ? inner(parent) : parent;
    // SWR keys its state for a cache by the object itself, so a wrapper would split the hooks from `mutate`.
    watchSWR({ cache }, options);
    return cache;
  };
}

/**
 * Describes an SWR cache entry without its data. Self-contained: the Metro bridge runs it from its source
 * inside apps without the SDK, so it uses nothing from module scope. `updatedAt` is when the entry's
 * data or error was last seen changing. Entries with only SWR's internal fields give undefined.
 */
export function summarizeSWREntry(key: string, entry: unknown, updatedAt?: number): StateEntrySummary | undefined {
  if (entry === null || typeof entry !== 'object') return undefined;
  const state = entry as { data?: unknown; error?: unknown; isValidating?: unknown; isLoading?: unknown; _k?: unknown };
  // `useSWRMutation` leaves `{ _c: undefined }` behind, and a hook that has not fetched only `{ _k }`.
  if (!('data' in state || 'error' in state || 'isValidating' in state || 'isLoading' in state)) return undefined;

  const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
  // The shape alone, never a value: the MCP server hands previews to AI assistants as they are.
  const preview = (value: unknown): string => {
    if (value === null) return 'null';
    if (typeof value === 'string') return `string(${value.length})`;
    if (typeof value !== 'object') return typeof value;
    if (Array.isArray(value)) return `Array(${value.length})`;
    const tag = Object.prototype.toString.call(value).slice(8, -1);
    if (tag === 'Map' || tag === 'Set') return `${tag}(${(value as { size: number }).size})`;
    if (tag === 'Date') return 'Date';
    // Only names that look like fields: an object keyed by ids, emails or tokens would show those.
    const fields: string[] = [];
    let more = false;
    let checked = 0;
    for (const name in value) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) continue;
      if (fields.length === 3 || ++checked > 10) {
        more = true;
        break;
      }
      if (name.length <= 24 && /^[A-Za-z_$]+\d*$/.test(name)) fields.push(name);
      else more = true;
    }
    const shape = `{${fields.join(', ')}${more ? (fields.length > 0 ? ', …' : '…') : ''}}`;
    const proto = Object.getPrototypeOf(value);
    const type = proto && proto !== Object.prototype && typeof proto.constructor === 'function' && proto.constructor.name;
    return type ? `${type} ${shape}` : shape;
  };
  const describeError = (error: unknown): string => {
    if (typeof error === 'string') return error;
    const { name, message, status } = (error !== null && typeof error === 'object' ? error : {}) as {
      name?: unknown;
      message?: unknown;
      status?: unknown;
    };
    const title = typeof name === 'string' && name ? name : 'Error';
    // Anything thrown that is not an error is described like data.
    let text = typeof message !== 'string' ? preview(error) : message ? `${title}: ${message}` : title;
    // SWR's docs put the HTTP status on the error, and the State tab shows a status it finds as "error 404".
    if (typeof status === 'number' && !text.includes(String(status))) text += ` (status ${status})`;
    return text;
  };

  const prefix = key.startsWith('$inf$') ? '$inf$' : key.startsWith('$sub$') ? '$sub$' : '';
  const kind: StateEntrySummary['kind'] = prefix === '$inf$' ? 'swr-infinite' : prefix ? 'swr-subscription' : 'swr';
  let label = key.slice(prefix.length);
  // A key that is not a string is stored hashed, e.g. `@"/api/user",1,`; `_k` keeps the hook's arguments.
  if (state._k !== null && typeof state._k === 'object') {
    try {
      label = JSON.stringify(state._k, (_, value) => (typeof value === 'bigint' ? `${value}n` : value)) ?? label;
    } catch {
      // cyclic arguments: the hashed key will do
    }
  }
  const { data, error } = state;
  const fetching = state.isValidating === true;
  const loading = fetching || state.isLoading === true;
  const status: StateEntrySummary['status'] =
    error !== undefined ? 'error' : data !== undefined ? 'success' : loading ? 'pending' : 'idle';
  const summary: StateEntrySummary = { key, label: cut(label, 1_000), kind, status, fetching };
  if (updatedAt !== undefined) summary.updatedAt = updatedAt;
  if (error !== undefined) summary.error = cut(describeError(error), 500);
  if (data !== undefined) summary.preview = preview(data);
  return summary;
}

// The registry holds this driver only as long as the cache lives, so the driver can hold the cache.
function swrDriver(cache: SWRCacheLike, label: string, watch: Watch): StoreDriver {
  interface Mark {
    data: unknown;
    error: unknown;
    /** When `data` or `error` last changed. */
    at: number;
  }
  /** The last write seen per key, least recent first. */
  const marks = new Map<string, Mark>();
  let report: ((key: unknown, value: unknown, removal: boolean) => void) | null = null;
  let probe: { key: string; hit: boolean } | null = null;
  /** Undo of each method patched; kept while another patch sits on top of ours, which then only passes calls on. */
  const restores: Partial<Record<'set' | 'delete', () => boolean>> = {};

  const read = (key: string): unknown => {
    try {
      return cache.get(key);
    } catch {
      return undefined;
    }
  };
  // Same rule as summarizeSWREntry, without building a summary for every key in the cache.
  const listed = (entry: unknown): boolean =>
    entry !== null &&
    typeof entry === 'object' &&
    ('data' in entry || 'error' in entry || 'isValidating' in entry || 'isLoading' in entry);

  const keys = (): string[] => {
    const shown: string[] = [];
    try {
      for (const key of cache.keys()) {
        if (typeof key === 'string' && listed(read(key))) shown.push(key);
      }
    } catch {
      // list what was read before the cache failed
    }
    if (shown.length <= MAX_KEYS) return shown;
    // The keys written to most recently, then the newest others; in cache order, so rows keep their place.
    const present = new Set(shown);
    const picked = new Set<string>();
    const recent = [...marks.keys()];
    for (let i = recent.length - 1; i >= 0 && picked.size < MAX_KEYS; i--) {
      if (present.has(recent[i]!)) picked.add(recent[i]!);
    }
    for (let i = shown.length - 1; i >= 0 && picked.size < MAX_KEYS; i--) picked.add(shown[i]!);
    return shown.filter((key) => picked.has(key));
  };

  const wrap = (name: 'set' | 'delete') => {
    if (restores[name]) return;
    const target = cache as unknown as Record<string, unknown>;
    const own = Object.getOwnPropertyDescriptor(target, name);
    const original = own && 'value' in own ? own.value : target[name];
    if (typeof original !== 'function') throw new Error(`The cache has no ${name}()`);
    const removal = name === 'delete';
    // SWR writes during render too (Suspense, providers): the write goes first, and the rest is O(1) and never throws.
    const wrapper = function (this: unknown, key: unknown, value: unknown) {
      const result = (original as (...args: unknown[]) => unknown).apply(this, arguments as unknown as unknown[]);
      if (report) {
        try {
          report(key, value, removal);
        } catch {
          // never break the app's cache
        }
      }
      return result;
    };
    const ours = () => Object.getOwnPropertyDescriptor(target, name)?.value === wrapper;
    Object.defineProperty(target, name, { value: wrapper, configurable: true, writable: true, enumerable: own?.enumerable ?? false });
    // A proxy can accept the definition and keep the old method.
    if (!ours()) throw new Error(`Could not patch the cache's ${name}()`);
    restores[name] = () => {
      if (!ours()) return false;
      if (own) Object.defineProperty(target, name, own);
      else delete target[name];
      return true;
    };
  };
  const unpatch = () => {
    for (const name of ['set', 'delete'] as const) {
      try {
        if (restores[name]?.()) delete restores[name];
      } catch {
        // left in place, passing calls on
      }
    }
  };

  const start: StoreDriver['start'] = (sink, id) => {
    report = (key, value, removal) => {
      if (typeof key !== 'string') return;
      if (removal) {
        marks.delete(key);
        sink.removed(id, key);
        return;
      }
      const state = (value !== null && typeof value === 'object' ? value : {}) as { data?: unknown; error?: unknown; isValidating?: unknown };
      const { data, error } = state;
      if (probe && probe.key === key && state.isValidating === true) probe.hit = true;
      let mark = marks.get(key);
      if (mark) marks.delete(key);
      if (!mark || mark.data !== data || mark.error !== error) mark = { data, error, at: Date.now() };
      marks.set(key, mark);
      sink.dirty(id, key);
    };
    try {
      wrap('set');
      wrap('delete');
    } catch (error) {
      report = null;
      unpatch();
      throw error;
    }
    return () => {
      report = null;
      marks.clear();
      unpatch();
    };
  };

  const act: StoreDriver['act'] = async (key, op) => {
    const mutate = watch.mutate;
    if (!mutate) return { done: false, note: NO_MUTATE };
    try {
      if (op === 'clear') {
        await mutate(key, undefined, { revalidate: false });
        return { done: true };
      }
      if (op !== 'revalidate' && op !== 'reset') return { done: false, note: `SWR has no "${op}"` };
      // A mounted hook revalidates within the call, and its first write sets `isValidating`.
      const call = { key, hit: false };
      probe = call;
      let pending: unknown;
      try {
        pending = op === 'revalidate' ? mutate(key) : mutate(key, undefined);
      } finally {
        probe = null;
      }
      if (op === 'reset') {
        await pending;
        return call.hit ? { done: true } : { done: true, note: 'Cleared; no mounted hook fetched it again' };
      }
      if (!call.hit) {
        Promise.resolve(pending).catch(noop);
        return { done: false, note: NO_HOOK };
      }
      await settle(pending, REVALIDATE_WAIT);
      return { done: true };
    } catch (error) {
      return { done: false, note: errorMessage(error) };
    }
  };

  return {
    info: { library: 'swr', label, via: 'cache', actions: false, ops: ['revalidate', 'clear', 'reset'] },
    keys,
    summarize: (key) => summarizeSWREntry(key, read(key), marks.get(key)?.at),
    data: (key) => {
      const entry = read(key);
      return entry !== null && typeof entry === 'object' ? (entry as { data?: unknown }).data : undefined;
    },
    act,
    start,
  };
}

function isCache(value: unknown): value is SWRCacheLike {
  if (value === null || typeof value !== 'object') return false;
  const cache = value as Record<string, unknown>;
  return (
    typeof cache.get === 'function' &&
    typeof cache.set === 'function' &&
    typeof cache.delete === 'function' &&
    typeof cache.keys === 'function'
  );
}

/** Resolves once `pending` settles, or after `ms`. */
function settle(pending: unknown, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    Promise.resolve(pending)
      .catch(noop)
      .then(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}
