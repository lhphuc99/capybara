import type { StateEntrySummary } from '@capybara-devtools/protocol';
import type { StoreDriver } from './index.js';
import { register, unregister } from './registry.js';

// `summarizeQuery`, `summarizeMutation` and `createQueryClientDriver` are self-contained, like the engine: the
// Metro bridge runs them from their source inside apps without the SDK, so they use nothing from module scope.
// TanStack Query v5 is the reference. v4 has the same cache events; where it differs, the code says so.

export interface WatchQueryClientOptions {
  /** The client's label in the State tab; give each its own when the app has several. Default "QueryClient". */
  name?: string;
}

/** What `watchQueryClient` checks for: a TanStack Query `QueryClient`, v5 or v4. */
export interface QueryClientLike {
  getQueryCache(): unknown;
  getMutationCache(): unknown;
}

export type SummarizeQueryFn = typeof summarizeQuery;
export type SummarizeMutationFn = typeof summarizeMutation;

interface QueryLike {
  queryKey?: unknown;
  queryHash: string;
  /** v5 only; v4 infinite queries are told apart by their data. */
  queryType?: unknown;
  options?: { queryFn?: unknown; queryKeyHashFn?: unknown };
  state: {
    data?: unknown;
    dataUpdatedAt?: number;
    error?: unknown;
    errorUpdatedAt?: number;
    isInvalidated?: boolean;
    /** v4 says 'loading' where v5 says 'pending'. */
    status?: string;
    fetchStatus?: string;
  };
  observers?: Array<{ options?: { queryFn?: unknown } } | undefined>;
  getObserversCount?(): number;
  isActive?(): boolean;
  isDisabled?(): boolean;
  isStale?(): boolean;
  fetch?(): unknown;
}

interface MutationLike {
  mutationId: number;
  options?: { mutationKey?: unknown };
  state: {
    /** v4 says 'loading' where v5 says 'pending'. */
    status?: string;
    isPaused?: boolean;
    /** v5 only. */
    submittedAt?: number;
    variables?: unknown;
    data?: unknown;
    context?: unknown;
    error?: unknown;
  };
}

type CacheEvent =
  | { type?: unknown; query?: Partial<QueryLike> | null; mutation?: Partial<MutationLike> | null }
  | null
  | undefined;

interface CacheLike<T> {
  subscribe(listener: (event: CacheEvent) => void): () => void;
  getAll(): Array<T | undefined>;
  get?(queryHash: string): T | undefined;
}

type ClientMethod = 'invalidateQueries' | 'resetQueries' | 'cancelQueries' | 'removeQueries';
type ClientFilter = { predicate(query: unknown): boolean };
type ClientLike = QueryClientLike & Partial<Record<ClientMethod, (filters: ClientFilter) => unknown>>;

/**
 * Shows the client's queries and mutations in the State tab, where a query can be refetched, invalidated,
 * reset, cancelled or removed. Returns a function that stops watching. Does nothing where there is no `window`.
 */
export function watchQueryClient(client: QueryClientLike, options?: WatchQueryClientOptions): () => void {
  if (typeof window === 'undefined') return () => {};
  let id: string | undefined;
  try {
    const name = options?.name;
    const label = typeof name === 'string' && name !== '' ? name : 'QueryClient';
    const driver = createQueryClientDriver(client, label, summarizeQuery, summarizeMutation);
    // A client registered before gets its id back, so calling this again adds nothing.
    if (driver) id = register(driver, client);
  } catch {
    // never throw into the app
  }
  return () => {
    const current = id;
    id = undefined;
    if (current === undefined) return;
    try {
      unregister(current);
    } catch {
      // never throw into the app
    }
  };
}

/**
 * Reads a QueryClient for the state engine: queries keyed by `queryHash`, mutations by `m:<mutationId>`.
 * Undefined for anything that is not a QueryClient.
 */
export function createQueryClientDriver(
  client: unknown,
  label: string,
  summarizeQuery: SummarizeQueryFn,
  summarizeMutation: SummarizeMutationFn,
): StoreDriver | undefined {
  // The engine and the UI hold 1200 entries per store.
  const MAX_QUERIES = 1_000;
  const MAX_MUTATIONS = 200;
  const REFETCH_TIMEOUT = 10_000;

  const isCache = (value: unknown): boolean =>
    value !== null &&
    typeof value === 'object' &&
    typeof (value as CacheLike<unknown>).subscribe === 'function' &&
    typeof (value as CacheLike<unknown>).getAll === 'function';
  const c = client as ClientLike | null;
  if (c === null || typeof c !== 'object') return undefined;
  if (typeof c.getQueryCache !== 'function' || typeof c.getMutationCache !== 'function') return undefined;
  let queries: CacheLike<QueryLike>;
  let mutations: CacheLike<MutationLike>;
  try {
    queries = c.getQueryCache() as CacheLike<QueryLike>;
    mutations = c.getMutationCache() as CacheLike<MutationLike>;
  } catch {
    return undefined;
  }
  if (!isCache(queries) || typeof queries.get !== 'function' || !isCache(mutations)) return undefined;

  const previews = new WeakMap<object, string>();
  const message = (error: unknown): string => {
    try {
      return error instanceof Error ? error.message : String(error);
    } catch {
      return 'unknown error';
    }
  };
  const queryOf = (key: string): QueryLike | undefined => {
    const query = queries.get!(key);
    return query !== null && typeof query === 'object' ? query : undefined;
  };
  const mutationOf = (key: string): MutationLike | undefined => {
    if (!key.startsWith('m:')) return undefined;
    const id = Number(key.slice(2));
    for (const mutation of mutations.getAll()) if (mutation?.mutationId === id) return mutation;
    return undefined;
  };
  const rank = (query: QueryLike): number => {
    try {
      const state = query.state;
      if (state.fetchStatus === 'fetching' || state.fetchStatus === 'paused') return Infinity;
      return Math.max(Number(state.dataUpdatedAt) || 0, Number(state.errorUpdatedAt) || 0);
    } catch {
      return 0;
    }
  };
  const reply = (result: { done: boolean; note?: string }) => Promise.resolve(result);

  const refetch = (query: QueryLike): Promise<{ done: boolean; note?: string }> => {
    // Where `Query.fetch` takes its queryFn from, so a query it would reject is not put into an error state.
    const own = query.options?.queryFn;
    const queryFn = own || query.observers?.find((observer) => observer?.options?.queryFn)?.options?.queryFn;
    if (typeof queryFn !== 'function' || typeof query.fetch !== 'function') {
      return reply({ done: false, note: 'This query has no queryFn to refetch with' });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ done: false, note: `Still fetching after ${REFETCH_TIMEOUT / 1_000} s` }),
        REFETCH_TIMEOUT,
      );
      const settle = (result: { done: boolean; note?: string }) => {
        clearTimeout(timer);
        resolve(result);
      };
      new Promise((fetched) => fetched(query.fetch!())).then(
        () => settle({ done: true }),
        (error: unknown) => settle({ done: false, note: `Refetch failed: ${message(error)}` }),
      );
    });
  };
  const viaClient = (query: QueryLike, method: ClientMethod): Promise<{ done: boolean; note?: string }> => {
    const call = c[method];
    if (typeof call !== 'function') return reply({ done: false, note: `This QueryClient has no ${method}` });
    try {
      // The filter is the query itself: a key rebuilt from JSON can hash differently.
      const pending = call.call(c, { predicate: (other: unknown) => other === query });
      // Settles once active queries have refetched; the change itself is already made.
      Promise.resolve(pending).catch(() => {});
    } catch (error) {
      return reply({ done: false, note: message(error) });
    }
    return reply({ done: true });
  };

  return {
    info: {
      library: 'tanstack-query',
      label,
      via: 'client',
      actions: false,
      ops: ['refetch', 'invalidate', 'reset', 'cancel', 'remove'],
    },
    keys() {
      const ranked: Array<{ key: string; rank: number; at: number }> = [];
      queries.getAll().forEach((query, at) => {
        if (typeof query?.queryHash === 'string') ranked.push({ key: query.queryHash, rank: rank(query), at });
      });
      // Fetching first, then the latest data or error; ties newest first. Two fetching give NaN, which falls through.
      ranked.sort((a, b) => b.rank - a.rank || b.at - a.at);
      const keys = ranked.slice(0, MAX_QUERIES).map((entry) => entry.key);
      const ids: number[] = [];
      for (const mutation of mutations.getAll()) {
        if (typeof mutation?.mutationId === 'number') ids.push(mutation.mutationId);
      }
      ids.sort((a, b) => b - a);
      for (const id of ids.slice(0, MAX_MUTATIONS)) keys.push(`m:${id}`);
      return keys;
    },
    summarize(key) {
      const query = queryOf(key);
      if (query) return summarizeQuery(query, previews);
      const mutation = mutationOf(key);
      return mutation ? summarizeMutation(mutation) : undefined;
    },
    data(key) {
      const query = queryOf(key);
      if (query) return query.state?.data;
      const state = mutationOf(key)?.state;
      if (!state) return undefined;
      const out: Record<string, unknown> = { variables: state.variables, data: state.data };
      if (state.context !== undefined) out.context = state.context;
      if (state.error !== null && state.error !== undefined) out.error = state.error;
      return out;
    },
    act(key, op) {
      const query = queryOf(key);
      if (!query) {
        const note = mutationOf(key)
          ? 'Mutations only report what happened; there is nothing to run'
          : 'This query is no longer in the cache';
        return reply({ done: false, note });
      }
      switch (op) {
        case 'refetch':
          return refetch(query);
        case 'invalidate':
          return viaClient(query, 'invalidateQueries');
        case 'reset':
          return viaClient(query, 'resetQueries');
        case 'cancel':
          if (query.state?.fetchStatus === 'idle') return reply({ done: false, note: 'This query is not fetching' });
          return viaClient(query, 'cancelQueries');
        case 'remove':
          return viaClient(query, 'removeQueries');
        default:
          return reply({ done: false, note: `Queries have no "${String(op)}" command` });
      }
    },
    start(sink, id) {
      // Events can come mid-render (hydration), so listeners only mark keys; the engine reads them later.
      const low = (type: unknown) => type === 'observerResultsUpdated' || type === 'observerOptionsUpdated';
      const stopQueries = queries.subscribe((event) => {
        try {
          const hash = event?.query?.queryHash;
          if (typeof hash !== 'string') return;
          if (event!.type === 'removed') sink.removed(id, hash);
          else sink.dirty(id, hash, low(event!.type));
        } catch {
          // never throw into the app's cache
        }
      });
      let stopMutations: () => void;
      try {
        stopMutations = mutations.subscribe((event) => {
          try {
            // `observerOptionsUpdated` comes without a mutation while an observer has none yet.
            const mutationId = event?.mutation?.mutationId;
            if (typeof mutationId !== 'number') return;
            if (event!.type === 'removed') sink.removed(id, `m:${mutationId}`);
            else sink.dirty(id, `m:${mutationId}`, low(event!.type));
          } catch {
            // never throw into the app's cache
          }
        });
      } catch (error) {
        stopQueries();
        throw error;
      }
      return () => {
        stopQueries();
        stopMutations();
      };
    },
  };
}

/**
 * A query's summary, without its data. `previews` remembers the preview of each data object: TanStack keeps the
 * same object until the data changes, while observer updates summarize the query again and again.
 */
export function summarizeQuery(query: unknown, previews?: WeakMap<object, string>): StateEntrySummary | undefined {
  const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
  const attempt = <T>(read: () => T): T | undefined => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  // The same as in summarizeMutation: each is run on its own.
  const errorText = (error: unknown): string => {
    let text = 'Error';
    try {
      const e = error as { name?: unknown; message?: unknown } | null;
      if (typeof error === 'string') {
        text = error;
      } else if (e !== null && typeof e === 'object' && typeof e.message === 'string') {
        const kind = typeof e.name === 'string' && e.name ? e.name : 'Error';
        text = e.message ? `${kind}: ${e.message}` : kind;
      } else if (e !== null && typeof e === 'object') {
        // Not its fields, which may hold anything; a thrown response's status is what tells the most.
        const kind = Object.prototype.toString.call(e).slice(8, -1);
        const status = (e as { status?: unknown }).status;
        text = typeof status === 'number' ? `${kind} ${status}` : kind;
      } else {
        text = String(error);
      }
    } catch {
      // unreadable; keep the default
    }
    return cut(text, 300);
  };
  const typeName = (value: object): string => {
    try {
      const proto = Object.getPrototypeOf(value);
      const name: unknown = proto === null ? 'Object' : proto.constructor?.name;
      return typeof name === 'string' && name !== '' ? name : 'Object';
    } catch {
      return 'Object';
    }
  };
  // The shape only, never a value: MCP shows previews as they are, and its redactor only sees key names.
  const describe = (data: unknown): string => {
    if (data === null) return 'null';
    if (typeof data === 'string') return `string(${data.length})`;
    if (typeof data !== 'object') return typeof data;
    if (Array.isArray(data)) return `Array(${data.length})`;
    if (data instanceof Map) return `Map(${data.size})`;
    if (data instanceof Set) return `Set(${data.size})`;
    if (data instanceof Date) return 'Date';
    const name = typeName(data);
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return name;
    const keys: string[] = [];
    let length = 0;
    let more = false;
    try {
      for (const key in data) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
        const shown = cut(key, 20);
        if (keys.length > 0 && length + shown.length > 60) {
          more = true;
          break;
        }
        keys.push(shown);
        length += shown.length + 2;
      }
    } catch {
      // a proxy that will not list its keys
    }
    const body = `{${keys.join(', ')}${more ? ', …' : ''}}`;
    return name === 'Object' ? body : `${name} ${body}`;
  };

  const q = query as QueryLike | null;
  if (q === null || typeof q !== 'object' || typeof q.queryHash !== 'string') return undefined;
  const state = q.state;
  if (state === null || typeof state !== 'object') return undefined;
  const data = state.data;
  // The default hash is the key as JSON with sorted object keys, as TanStack's devtools show it; a custom one may be
  // opaque, so then the key is shown.
  const bigints = (_: string, value: unknown) => (typeof value === 'bigint' ? `${value}n` : value);
  const custom = typeof q.options?.queryKeyHashFn === 'function';
  const json = custom ? attempt(() => JSON.stringify(q.queryKey, bigints)) : undefined;
  const pages =
    data !== null &&
    typeof data === 'object' &&
    Array.isArray((data as { pages?: unknown }).pages) &&
    Array.isArray((data as { pageParams?: unknown }).pageParams);
  const status = state.status === 'loading' ? 'pending' : state.status;
  const count = attempt(() => (q.getObserversCount ? q.getObserversCount() : q.observers?.length));
  const observers = typeof count === 'number' && count > 0 ? count : 0;
  const active = attempt(() => q.isActive?.());

  const summary: StateEntrySummary = {
    key: q.queryHash,
    label: cut(json ?? q.queryHash, 1_024),
    kind: q.queryType === 'infinite' || pages ? 'infinite' : 'query',
    status: status === 'success' || status === 'error' ? status : 'pending',
    fetching: state.fetchStatus === 'fetching',
  };
  if (state.fetchStatus === 'paused') summary.paused = true;
  // Without observers there is no staleTime to judge by: TanStack's devtools call such a query inactive, nothing more.
  if (observers > 0) {
    const stale = attempt(() => q.isStale?.());
    if (typeof stale === 'boolean') summary.stale = stale;
  }
  if (state.isInvalidated === true) summary.invalidated = true;
  summary.active = typeof active === 'boolean' ? active : observers > 0;
  if (attempt(() => q.isDisabled?.()) === true) summary.disabled = true;
  summary.observers = observers;
  // A query that only ever failed has no data time, so the error's time stands in.
  const updatedAt = Math.max(Number(state.dataUpdatedAt) || 0, Number(state.errorUpdatedAt) || 0);
  if (updatedAt > 0) summary.updatedAt = updatedAt;
  if (state.error !== null && state.error !== undefined) summary.error = errorText(state.error);
  if (data !== undefined) {
    const keyed = data !== null && typeof data === 'object' ? data : undefined;
    let preview = keyed ? previews?.get(keyed) : undefined;
    if (preview === undefined) {
      preview = describe(data);
      if (keyed) previews?.set(keyed, preview);
    }
    summary.preview = preview;
  }
  return summary;
}

/** A mutation without its variables or data. */
export function summarizeMutation(mutation: unknown): StateEntrySummary | undefined {
  // The same as in summarizeQuery: each is run on its own.
  const errorText = (error: unknown): string => {
    let text = 'Error';
    try {
      const e = error as { name?: unknown; message?: unknown } | null;
      if (typeof error === 'string') {
        text = error;
      } else if (e !== null && typeof e === 'object' && typeof e.message === 'string') {
        const kind = typeof e.name === 'string' && e.name ? e.name : 'Error';
        text = e.message ? `${kind}: ${e.message}` : kind;
      } else if (e !== null && typeof e === 'object') {
        // Not its fields, which may hold anything; a thrown response's status is what tells the most.
        const kind = Object.prototype.toString.call(e).slice(8, -1);
        const status = (e as { status?: unknown }).status;
        text = typeof status === 'number' ? `${kind} ${status}` : kind;
      } else {
        text = String(error);
      }
    } catch {
      // unreadable; keep the default
    }
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  };

  const m = mutation as MutationLike | null;
  if (m === null || typeof m !== 'object' || typeof m.mutationId !== 'number') return undefined;
  const state = m.state;
  if (state === null || typeof state !== 'object') return undefined;
  let name = 'mutation';
  try {
    const key = m.options?.mutationKey;
    const bigints = (_: string, value: unknown) => (typeof value === 'bigint' ? `${value}n` : value);
    const json = key === undefined ? undefined : JSON.stringify(key, bigints);
    if (json) name = json.length > 1_024 ? `${json.slice(0, 1_024)}…` : json;
  } catch {
    // the id still tells it apart
  }
  const status = state.status === 'loading' ? 'pending' : state.status;
  const summary: StateEntrySummary = {
    key: `m:${m.mutationId}`,
    // Every call of a mutation is its own entry, so the id tells calls with the same key apart.
    label: `${name} #${m.mutationId}`,
    kind: 'mutation',
    status: status === 'pending' || status === 'success' || status === 'error' ? status : 'idle',
    fetching: status === 'pending' && state.isPaused !== true,
  };
  if (state.isPaused === true) summary.paused = true;
  if (typeof state.submittedAt === 'number' && state.submittedAt > 0) summary.updatedAt = state.submittedAt;
  if (state.error !== null && state.error !== undefined) summary.error = errorText(state.error);
  return summary;
}
