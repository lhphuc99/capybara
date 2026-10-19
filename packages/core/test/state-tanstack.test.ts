import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MutationObserver,
  QueryClient,
  QueryObserver,
  environmentManager,
  isServer,
  skipToken,
  type QueryCacheNotifyEvent,
} from '@tanstack/query-core';
import type { StateCommands, StateEntryOp, StateEntrySummary, StatePath } from '@capybara-devtools/protocol';
import { CLIENT_GLOBAL, serialize, statePlugin, type PluginContext } from '../src/index.js';
import { REGISTRY_GLOBAL } from '../src/plugins/state/registry.js';
import {
  createQueryClientDriver,
  summarizeMutation,
  summarizeQuery,
  watchQueryClient,
} from '../src/plugins/state/tanstack.js';

type Recorded = { kind: string; payload: any };

const T0 = Date.UTC(2026, 9, 18, 14, 0, 0);
const STORE = 'tanstack-query:1';
const OPS = ['refetch', 'invalidate', 'reset', 'cancel', 'remove'];

const teardowns: Array<() => void> = [];

function harness() {
  const events: Recorded[] = [];
  const ctx: PluginContext = { emit: (kind, payload) => events.push({ kind, payload }), serialize, console };
  const plugin = statePlugin();
  teardowns.push(plugin.setup!(ctx) as () => void);
  const commands = plugin.commands!;
  return {
    of: (kind: string) => events.filter((e) => e.kind === kind).map((e) => e.payload),
    entries: (store = STORE) => commands.entries!({ store }) as StateCommands['entries']['result'],
    entry: (key: string, path?: StatePath, store = STORE) =>
      commands.entry!({ store, key, path }) as StateCommands['entry']['result'],
    act: (key: string, op: StateEntryOp, store = STORE) =>
      commands.act!({ store, key, op }) as Promise<StateCommands['act']['result']>,
  };
}

/** Cache events as `type` or `updated:<action>`, the way the research counted them. */
function recordEvents(client: QueryClient): string[] {
  const seen: string[] = [];
  client.getQueryCache().subscribe((event: QueryCacheNotifyEvent) => {
    seen.push(event.type === 'updated' ? `updated:${event.action.type}` : event.type);
  });
  return seen;
}

const query = (key: string, extra: Partial<StateEntrySummary> = {}): StateEntrySummary => ({
  key,
  label: key,
  kind: 'query',
  status: 'success',
  fetching: false,
  ...extra,
});

const mutation = (id: number, label: string, extra: Partial<StateEntrySummary> = {}): StateEntrySummary => ({
  key: `m:${id}`,
  label,
  kind: 'mutation',
  status: 'success',
  fetching: false,
  ...extra,
});

const milk = () => Promise.resolve(['milk']);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.stubGlobal('window', globalThis);
  // The engine reads the connection from the active client; there is none here, so fake one that is online.
  vi.stubGlobal(CLIENT_GLOBAL, { connected: true });
  // As in a browser, so retries, garbage collection and stale timers all run.
  environmentManager.setIsServer(() => false);
});

afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
  environmentManager.setIsServer(() => isServer);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>)[REGISTRY_GLOBAL];
});

describe('watchQueryClient', () => {
  it('registers a client once, and listens to its caches only while the plugin runs', () => {
    const client = new QueryClient();
    const untrack = watchQueryClient(client);
    watchQueryClient(client);
    expect(client.getQueryCache().hasListeners()).toBe(false);

    const { of } = harness();
    const info = { id: STORE, library: 'tanstack-query', label: 'QueryClient', via: 'client', actions: false, ops: OPS };
    expect(of('state.store')).toEqual([{ store: info }]);
    expect(client.getQueryCache().hasListeners()).toBe(true);
    expect(client.getMutationCache().hasListeners()).toBe(true);

    untrack();
    expect(of('state.store').at(-1)).toEqual({ store: { ...info, disposed: true } });
    expect(client.getQueryCache().hasListeners()).toBe(false);
    expect(client.getMutationCache().hasListeners()).toBe(false);
    expect(() => untrack()).not.toThrow();
  });

  it('does nothing without a window, or for something that is not a QueryClient', () => {
    vi.unstubAllGlobals();
    expect(typeof window).toBe('undefined');
    const client = new QueryClient();
    const untrack = watchQueryClient(client);
    const { of } = harness();
    expect(of('state.store')).toEqual([]);
    expect(client.getQueryCache().hasListeners()).toBe(false);
    expect(() => untrack()).not.toThrow();

    vi.stubGlobal('window', globalThis);
    for (const target of [null, {}, { getQueryCache: () => ({}), getMutationCache: () => ({}) }]) {
      expect(() => watchQueryClient(target as unknown as QueryClient)()).not.toThrow();
    }
    expect(of('state.store')).toEqual([]);
  });

  it('tells several clients apart by label', async () => {
    const main = new QueryClient();
    const admin = new QueryClient();
    watchQueryClient(main);
    watchQueryClient(admin, { name: 'admin' });
    const { of, entries } = harness();
    expect(of('state.store').map((e) => [e.store.id, e.store.label])).toEqual([
      ['tanstack-query:1', 'QueryClient'],
      ['tanstack-query:2', 'admin'],
    ]);

    main.setQueryData(['me'], { id: 1 });
    admin.setQueryData(['users'], []);
    await vi.advanceTimersByTimeAsync(200);
    expect(of('state.entries').map((p) => [p.store, p.upserts.map((e: StateEntrySummary) => e.key)])).toEqual([
      ['tanstack-query:1', ['["me"]']],
      ['tanstack-query:2', ['["users"]']],
    ]);
    expect(entries('tanstack-query:2').entries.map((e) => e.key)).toEqual(['["users"]']);
  });
});

describe('watchQueryClient summaries', () => {
  it('summarizes fetched queries: data as a short preview, an error as its name and message', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    watchQueryClient(client);
    const { of, entry } = harness();
    await client.fetchQuery({ queryKey: ['user', 1], queryFn: async () => ({ id: 1, name: 'Ann', tags: ['a', 'b'] }) });
    await expect(
      client.fetchQuery({
        queryKey: ['user', 2],
        queryFn: async () => {
          throw new Error('Request failed with status code 404');
        },
      }),
    ).rejects.toThrow('404');
    await client.fetchInfiniteQuery({
      queryKey: ['feed'],
      queryFn: async ({ pageParam }) => [`post ${pageParam}`],
      initialPageParam: 0,
      getNextPageParam: (_last: string[], pages: string[][]) => pages.length,
    });
    await vi.advanceTimersByTimeAsync(200);

    const user = query('["user",1]', { active: false, observers: 0, updatedAt: T0, preview: '{id, name, tags}' });
    const missing = query('["user",2]', {
      status: 'error',
      invalidated: true,
      active: false,
      observers: 0,
      updatedAt: T0,
      error: 'Error: Request failed with status code 404',
    });
    const feed = query('["feed"]', {
      kind: 'infinite',
      active: false,
      observers: 0,
      updatedAt: T0,
      preview: '{pages, pageParams}',
    });
    // Updated at the same moment, so the newest query comes first.
    expect(of('state.entries')).toEqual([{ store: STORE, upserts: [feed, missing, user], removed: [], reset: true }]);
    expect(entry('["user",1]', ['tags'])).toEqual({ summary: user, data: ['a', 'b'], truncated: false });
    expect(entry('["user",2]')).toEqual({ summary: missing, data: { $t: 'undefined' }, truncated: false });
    expect(entry('["gone"]')).toBeNull();
  });

  it('reads data only when asked for it', async () => {
    let reads = 0;
    const client = new QueryClient();
    client.setQueryData(['session'], {
      user: {
        get token() {
          reads++;
          return 'secret';
        },
      },
      list: Array.from({ length: 1_000 }, (_, id) => ({ id })),
    });
    watchQueryClient(client);
    const { of, entry } = harness();
    await vi.advanceTimersByTimeAsync(200);

    expect(of('state.entries')[0].upserts[0].preview).toBe('{user, list}');
    expect(JSON.stringify(of('state.entries'))).not.toContain('secret');
    expect(reads).toBe(0);
    expect(entry('["session"]', ['user', 'token'])?.data).toBe('secret');
    expect(reads).toBe(1);
  });

  it('summarizes mutations, newest first, and gives them no commands', async () => {
    const client = new QueryClient();
    watchQueryClient(client);
    const { entries, entry, act } = harness();
    const add = new MutationObserver(client, {
      mutationKey: ['todos', 'add'],
      mutationFn: (title: string) => Promise.resolve({ id: 1, title }),
    });
    await add.mutate('milk');
    const save = new MutationObserver(client, { mutationFn: () => Promise.reject(new Error('HTTP 500')) });
    await save.mutate().catch(() => {});
    const slow = new MutationObserver(client, { mutationFn: () => new Promise(() => {}) });
    void slow.mutate();

    const added = mutation(1, '["todos","add"] #1', { updatedAt: T0 });
    expect(entries().entries).toEqual([
      mutation(3, 'mutation #3', { status: 'pending', fetching: true, updatedAt: T0 }),
      mutation(2, 'mutation #2', { status: 'error', updatedAt: T0, error: 'Error: HTTP 500' }),
      added,
    ]);
    const data = { variables: 'milk', data: { id: 1, title: 'milk' } };
    expect(entry('m:1')).toEqual({ summary: added, data, truncated: false });
    await expect(act('m:1', 'refetch')).resolves.toEqual({
      done: false,
      note: 'Mutations only report what happened; there is nothing to run',
    });
  });

  it('normalises TanStack Query v4: "loading" is "pending", infinite queries are told by their data', () => {
    const state = {
      data: undefined,
      dataUpdateCount: 0,
      dataUpdatedAt: 0,
      error: null,
      errorUpdateCount: 0,
      errorUpdatedAt: 0,
      fetchFailureCount: 0,
      fetchFailureReason: null,
      fetchMeta: null,
      isInvalidated: false,
      status: 'loading',
      fetchStatus: 'fetching',
    };
    // v4 has cacheTime where v5 has gcTime, and no queryType, isFetched or isStatic.
    const v4Query = {
      queryKey: ['todos'],
      queryHash: '["todos"]',
      cacheTime: 300_000,
      options: { queryKey: ['todos'], queryFn: () => Promise.resolve([]), cacheTime: 300_000 },
      observers: [{}],
      state,
      getObserversCount: () => 1,
      isActive: () => true,
      isDisabled: () => false,
      isStale: () => true,
    };
    expect(summarizeQuery(v4Query)).toEqual(
      query('["todos"]', { status: 'pending', fetching: true, stale: true, active: true, observers: 1 }),
    );

    const data = { pages: [[1], [2]], pageParams: [0, 1] };
    const pages = { ...v4Query, state: { ...state, status: 'success', fetchStatus: 'idle', data, dataUpdatedAt: T0 } };
    expect(summarizeQuery(pages)).toMatchObject({ kind: 'infinite', status: 'success', preview: '{pages, pageParams}' });

    const v4Mutation = {
      mutationId: 4,
      cacheTime: 300_000,
      options: { mutationKey: ['add'], cacheTime: 300_000 },
      observers: [],
      state: { status: 'loading', isPaused: false, variables: 'x', data: undefined, error: null, failureCount: 0 },
    };
    expect(summarizeMutation(v4Mutation)).toEqual(mutation(4, '["add"] #4', { status: 'pending', fetching: true }));
    const paused = { ...v4Mutation, state: { ...v4Mutation.state, isPaused: true } };
    expect(summarizeMutation(paused)).toMatchObject({ fetching: false, paused: true });
    expect(summarizeQuery({ queryHash: 1 })).toBeUndefined();
    expect(summarizeMutation(null)).toBeUndefined();
  });

  it('previews data by its shape only, so no value can reach MCP through it', () => {
    const secret = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';
    const client = new QueryClient();
    const shapes: Array<[unknown, string]> = [
      [secret, `string(${secret.length})`],
      [{ token: secret, user: { password: 'hunter2' } }, '{token, user}'],
      [[secret, secret], 'Array(2)'],
      [new Map([['token', secret]]), 'Map(1)'],
      [new Set([secret]), 'Set(1)'],
      [42, 'number'],
      [true, 'boolean'],
      [null, 'null'],
      [new Date(0), 'Date'],
      [new (class Session { token = secret })(), 'Session {token}'],
      [
        Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`field${i}`, secret])),
        '{field0, field1, field2, field3, field4, field5, field6, …}',
      ],
    ];
    shapes.forEach(([data, preview], i) => {
      client.setQueryData(['case', i], data);
      const summary = summarizeQuery(client.getQueryCache().find({ queryKey: ['case', i] }));
      expect(summary?.preview).toBe(preview);
      expect(JSON.stringify(summary)).not.toMatch(/eyJ|hunter2/);
    });

    // Nor through an error that is not an Error, nor a mutation's variables.
    const failing = client.getQueryCache().build(client, { queryKey: ['failing'] });
    failing.setState({ status: 'error', error: { status: 401, token: secret } as unknown as Error });
    expect(summarizeQuery(failing)?.error).toBe('Object 401');
    const login = client.getMutationCache().build(client, { mutationKey: ['login'] });
    login.state = { ...login.state, status: 'error', variables: { password: 'hunter2' }, error: { token: secret } };
    expect(summarizeMutation(login)).toEqual(mutation(1, '["login"] #1', { status: 'error', error: 'Object' }));
  });

  it('labels a query with a custom hash by its key, and cuts long labels and errors', () => {
    const client = new QueryClient();
    const custom = client.getQueryCache().build(client, { queryKey: ['todo', 7n], queryKeyHashFn: () => 'todo-7' });
    expect(summarizeQuery(custom)).toMatchObject({ key: 'todo-7', label: '["todo","7n"]' });

    const long = client.getQueryCache().build(client, { queryKey: ['x'.repeat(2_000)] });
    long.setState({ status: 'error', error: new Error('y'.repeat(1_000)) });
    const summary = summarizeQuery(long)!;
    expect(summary.label).toHaveLength(1_025);
    expect(summary.error).toBe(`Error: ${'y'.repeat(293)}…`);

    for (const [error, text] of [
      ['offline', 'offline'],
      [new Response(null, { status: 404 }), 'Response 404'],
      [Object.assign(new Error(''), { name: 'AbortError' }), 'AbortError'],
    ] as const) {
      long.setState({ error: error as unknown as Error });
      expect(summarizeQuery(long)!.error).toBe(text);
    }
  });
});

describe('watchQueryClient patches', () => {
  it('counts the events of a fetch for real, and sends each burst as one patch', async () => {
    const client = new QueryClient();
    const seen = recordEvents(client);
    watchQueryClient(client);
    const { of } = harness();
    await vi.advanceTimersByTimeAsync(200);
    expect(of('state.entries')).toEqual([{ store: STORE, upserts: [], removed: [], reset: true }]);

    const first = new QueryObserver(client, { queryKey: ['todos'], queryFn: () => Promise.resolve(['milk', 'eggs']) });
    first.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.splice(0)).toEqual([
      'added',
      'observerResultsUpdated',
      'observerAdded',
      'observerResultsUpdated',
      'updated:fetch',
      'observerResultsUpdated',
      'updated:success',
    ]);
    await vi.advanceTimersByTimeAsync(200);
    const fetched = { stale: true, active: true, observers: 1, updatedAt: T0 + 200, preview: 'Array(2)' };
    expect(of('state.entries').slice(1)).toEqual([{ store: STORE, upserts: [query('["todos"]', fetched)], removed: [] }]);

    // A refetch: two `updated`, and two results per observer.
    await first.refetch();
    expect(seen.splice(0)).toEqual(['observerResultsUpdated', 'updated:fetch', 'observerResultsUpdated', 'updated:success']);
    const second = new QueryObserver(client, { queryKey: ['todos'], queryFn: () => Promise.resolve(['milk', 'eggs']) });
    second.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    seen.length = 0;
    await first.refetch();
    expect(seen.splice(0)).toEqual([
      'observerResultsUpdated',
      'observerResultsUpdated',
      'updated:fetch',
      'observerResultsUpdated',
      'observerResultsUpdated',
      'updated:success',
    ]);
    await vi.advanceTimersByTimeAsync(200);
    expect(of('state.entries').slice(2)).toEqual([
      { store: STORE, upserts: [query('["todos"]', { ...fetched, observers: 2, updatedAt: T0 + 400 })], removed: [] },
    ]);
  });

  it('sends observer noise at most once a second, and real changes within 200 ms', async () => {
    const client = new QueryClient();
    let optionEvents = 0;
    client.getQueryCache().subscribe((event) => {
      if (event.type === 'observerOptionsUpdated') optionEvents++;
    });
    watchQueryClient(client);
    const { of } = harness();
    const observer = new QueryObserver(client, { queryKey: ['todos'], queryFn: milk, staleTime: Infinity });
    observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
    const sent = of('state.entries').length;
    const since = () => of('state.entries').slice(sent);

    // Each render passes a new inline queryFn; flipping staleTime makes the summary really change too, ending stale.
    for (let i = 0; i < 50; i++) {
      const staleTime = i % 2 === 0 ? Infinity : 0;
      observer.setOptions({ queryKey: ['todos'], queryFn: () => Promise.resolve(['milk']), staleTime });
      if (i === 49) expect(since()).toEqual([]);
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(optionEvents).toBe(50);
    expect(since()).toEqual([
      { store: STORE, upserts: [expect.objectContaining({ key: '["todos"]', stale: true })], removed: [] },
    ]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(since()).toHaveLength(1);

    for (let n = 1; n <= 50; n++) client.setQueryData(['todos'], Array.from({ length: n }, () => 'milk'));
    await vi.advanceTimersByTimeAsync(199);
    expect(since()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(since()[1]).toEqual({ store: STORE, upserts: [expect.objectContaining({ preview: 'Array(50)' })], removed: [] });
  });

  it('shows a query going stale on its own, which only observer results report', async () => {
    const client = new QueryClient();
    watchQueryClient(client);
    const { of } = harness();
    const observer = new QueryObserver(client, { queryKey: ['todos'], queryFn: milk, staleTime: 5_000 });
    observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(200);
    const fresh = query('["todos"]', { stale: false, active: true, observers: 1, updatedAt: T0, preview: 'Array(1)' });
    expect(of('state.entries')).toEqual([{ store: STORE, upserts: [fresh], removed: [], reset: true }]);

    // The stale timer fires at 5 s; as observer noise it goes out within the next second.
    await vi.advanceTimersByTimeAsync(4_900);
    expect(of('state.entries')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(of('state.entries')[1]).toEqual({ store: STORE, upserts: [expect.objectContaining({ stale: true })], removed: [] });
  });

  it('keeps the 1000 queries updated last, fetching ones first, and the 200 newest mutations', async () => {
    const client = new QueryClient();
    for (let i = 0; i < 1_500; i++) client.setQueryData(['item', i], i, { updatedAt: T0 - 1_500_000 + i * 1_000 });
    for (let i = 0; i < 250; i++) client.getMutationCache().build(client, { mutationKey: ['save'] });
    void client.fetchQuery({ queryKey: ['item', 0], queryFn: () => new Promise(() => {}) });
    watchQueryClient(client);
    const { of, entries } = harness();
    await vi.advanceTimersByTimeAsync(200);

    const [reset] = of('state.entries');
    expect(reset).toMatchObject({ store: STORE, removed: [], reset: true });
    expect(reset.upserts).toHaveLength(200);
    const first = reset.upserts.slice(0, 3).map((e: StateEntrySummary) => e.key);
    expect(first).toEqual(['["item",0]', '["item",1499]', '["item",1498]']);

    const { entries: list, total } = entries();
    expect(total).toBe(1_200);
    const items = [0, ...Array.from({ length: 999 }, (_, i) => 1_499 - i)];
    expect(list.filter((e) => e.kind === 'query').map((e) => e.key)).toEqual(items.map((i) => `["item",${i}]`));
    expect(list.filter((e) => e.kind === 'mutation').map((e) => e.key)).toEqual(
      Array.from({ length: 200 }, (_, i) => `m:${250 - i}`),
    );
  });
});

describe('watchQueryClient commands', () => {
  it('invalidates, resets, cancels and removes only the query asked for', async () => {
    const client = new QueryClient();
    watchQueryClient(client);
    const { of, act } = harness();
    client.setQueryData(['a'], 'A');
    client.setQueryData(['b'], 'B');
    const observer = new QueryObserver(client, {
      queryKey: ['live'],
      queryFn: () => new Promise((resolve) => setTimeout(() => resolve('live'), 100)),
      staleTime: Infinity,
    });
    observer.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(200);

    await expect(act('["a"]', 'invalidate')).resolves.toEqual({ done: true });
    expect(client.getQueryState(['a'])).toMatchObject({ isInvalidated: true, fetchStatus: 'idle' });
    expect(client.getQueryState(['b'])?.isInvalidated).toBe(false);
    // An active query refetches once invalidated.
    await expect(act('["live"]', 'invalidate')).resolves.toEqual({ done: true });
    expect(client.getQueryState(['live'])).toMatchObject({ isInvalidated: true, fetchStatus: 'fetching' });
    await vi.advanceTimersByTimeAsync(100);
    expect(client.getQueryState(['live'])).toMatchObject({ isInvalidated: false, fetchStatus: 'idle', dataUpdateCount: 2 });

    await expect(act('["a"]', 'reset')).resolves.toEqual({ done: true });
    expect(client.getQueryState(['a'])).toMatchObject({ status: 'pending', data: undefined, isInvalidated: false });
    expect(client.getQueryData(['b'])).toBe('B');

    const hanging = client
      .fetchQuery({ queryKey: ['slow'], queryFn: () => new Promise(() => {}) })
      .catch((error: unknown) => error);
    await expect(act('["slow"]', 'cancel')).resolves.toEqual({ done: true });
    expect(client.getQueryState(['slow'])).toMatchObject({ status: 'pending', fetchStatus: 'idle' });
    expect(await hanging).toMatchObject({ message: 'CancelledError' });
    await expect(act('["slow"]', 'cancel')).resolves.toEqual({ done: false, note: 'This query is not fetching' });

    await vi.advanceTimersByTimeAsync(200);
    const sent = of('state.entries').length;
    await expect(act('["b"]', 'remove')).resolves.toEqual({ done: true });
    expect(client.getQueryCache().find({ queryKey: ['b'] })).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(of('state.entries').slice(sent)).toEqual([{ store: STORE, upserts: [], removed: ['["b"]'] }]);
    await expect(act('["b"]', 'refetch')).resolves.toEqual({ done: false, note: 'This query is no longer in the cache' });
  });

  it('refetches and waits for the fetch to settle, for up to 10 s', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const replies: Array<() => Promise<string>> = [
      () => Promise.resolve('first'),
      () => new Promise((resolve) => setTimeout(() => resolve('second'), 500)),
      () => Promise.reject(new Error('HTTP 500')),
      () => new Promise(() => {}),
    ];
    await client.fetchQuery({ queryKey: ['todos'], queryFn: () => replies.shift()!() });
    watchQueryClient(client);
    const { act } = harness();

    let result: unknown;
    void act('["todos"]', 'refetch').then((value) => (result = value));
    await vi.advanceTimersByTimeAsync(499);
    expect(result).toBeUndefined();
    expect(client.getQueryState(['todos'])?.fetchStatus).toBe('fetching');
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual({ done: true });
    expect(client.getQueryData(['todos'])).toBe('second');

    await expect(act('["todos"]', 'refetch')).resolves.toEqual({ done: false, note: 'Refetch failed: HTTP 500' });

    result = undefined;
    void act('["todos"]', 'refetch').then((value) => (result = value));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual({ done: false, note: 'Still fetching after 10 s' });
  });

  it('does not refetch a query without a queryFn, which would only put it in error', async () => {
    const client = new QueryClient();
    client.setQueryData(['manual'], 1);
    client.getQueryCache().build(client, { queryKey: ['skipped'], queryFn: skipToken });
    watchQueryClient(client);
    const { act } = harness();
    for (const key of ['["manual"]', '["skipped"]']) {
      await expect(act(key, 'refetch')).resolves.toEqual({ done: false, note: 'This query has no queryFn to refetch with' });
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.getQueryState(['manual'])).toMatchObject({ status: 'success', fetchStatus: 'idle', error: null, data: 1 });
  });
});

describe('TanStack Query summaries from source', () => {
  it('work from their source alone, as the Metro bridge will run them inside apps', async () => {
    const app = vm.createContext({ setTimeout, clearTimeout });
    const source =
      `({ summarizeQuery: ${summarizeQuery}, summarizeMutation: ${summarizeMutation}, ` +
      `createQueryClientDriver: ${createQueryClientDriver} })`;
    const inApp = vm.runInContext(source, app) as {
      summarizeQuery: typeof summarizeQuery;
      summarizeMutation: typeof summarizeMutation;
      createQueryClientDriver: typeof createQueryClientDriver;
    };
    const client = new QueryClient();
    await client.fetchQuery({ queryKey: ['todos', { done: false }], queryFn: () => Promise.resolve([{ id: 1, title: 'Milk' }]) });
    client.getMutationCache().build(client, { mutationKey: ['add'] });

    const driver = inApp.createQueryClientDriver(client, 'QueryClient', inApp.summarizeQuery, inApp.summarizeMutation)!;
    const local = createQueryClientDriver(client, 'QueryClient', summarizeQuery, summarizeMutation)!;
    const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
    expect(plain([...driver.keys!()])).toEqual(['["todos",{"done":false}]', 'm:1']);
    for (const key of local.keys!()) expect(plain(driver.summarize!(key))).toEqual(plain(local.summarize!(key)));
    expect(plain(driver.summarize!('["todos",{"done":false}]'))).toMatchObject({ preview: 'Array(1)', updatedAt: T0 });
    await expect(driver.act!('["todos",{"done":false}]', 'refetch')).resolves.toEqual({ done: true });
    expect(inApp.createQueryClientDriver({}, 'QueryClient', inApp.summarizeQuery, inApp.summarizeMutation)).toBeUndefined();
  });
});
