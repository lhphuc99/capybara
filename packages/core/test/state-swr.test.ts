// @vitest-environment happy-dom
import vm from 'node:vm';
import { act, createElement, StrictMode, Suspense, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import useSWR, { SWRConfig, mutate, unload, useSWRConfig } from 'swr';
import useSWRInfinite from 'swr/infinite';
import useSWRMutation from 'swr/mutation';
import useSWRSubscription from 'swr/subscription';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_GLOBAL, serialize, statePlugin, type PluginContext, type StateSink, type StoreDriver } from '../src/index.js';
import { REGISTRY_GLOBAL, attach } from '../src/plugins/state/registry.js';
import { summarizeSWREntry, swrMiddleware, swrProvider, watchSWR } from '../src/plugins/state/swr.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Recorded = { kind: string; payload: any };

const cleanups: Array<() => unknown> = [];
const defaultCache = SWRConfig.defaultValue.cache as Map<string, any>;
const quiet: StateSink = { record: () => {}, dirty: () => {}, removed: () => {} };

function harness() {
  const events: Recorded[] = [];
  const ctx: PluginContext = { emit: (kind, payload) => events.push({ kind, payload }), serialize, console };
  const plugin = statePlugin();
  const teardown = plugin.setup!(ctx) as () => void;
  cleanups.push(teardown);
  const of = (kind: string) => events.filter((e) => e.kind === kind).map((e) => e.payload);
  return { commands: plugin.commands!, of, teardown };
}

/** The module remembers watched caches, so each test untracks its own. */
function watch(...args: Parameters<typeof watchSWR>) {
  const untrack = watchSWR(...args);
  cleanups.push(untrack);
  return untrack;
}

/** The driver watchSWR registers, caught by a stand-in for the engine so a test can start it by hand. */
function registered(target: Parameters<typeof watchSWR>[0]) {
  const found: Array<{ id: string; driver: StoreDriver }> = [];
  const detach = attach({ track: (id, driver) => void found.push({ id, driver }), untrack: () => {} });
  // `attach` first hands over the stores registered before.
  found.length = 0;
  watch(target);
  detach();
  const { id, driver } = found[0]!;
  const start = (sink: StateSink) => {
    const stop = driver.start(sink, id) as () => void;
    cleanups.push(stop);
    return stop;
  };
  return { driver, start };
}

async function render(node: ReactNode): Promise<HTMLElement> {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(node));
  cleanups.push(() => act(() => root.unmount()));
  return container;
}

function Fetch({ id, fetcher }: { id: string; fetcher: (key: string) => Promise<unknown> }) {
  const { data, error } = useSWR(id, fetcher, { shouldRetryOnError: false, revalidateOnFocus: false });
  return createElement('output', null, error ? `error: ${(error as Error).message}` : JSON.stringify(data ?? null));
}

const counter = () => {
  let n = 0;
  return vi.fn(async (key: string) => ({ key, n: ++n }));
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(CLIENT_GLOBAL, { connected: true });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>)[REGISTRY_GLOBAL];
  // SWR's default cache lives as long as the module, so across tests.
  unload({ revalidate: false });
});

describe('summarizeSWREntry', () => {
  it('describes an entry without its data', () => {
    const user = { data: { id: 1, name: 'Ann', email: 'ann@example.com', role: 'admin' }, isValidating: true, isLoading: false, _k: ['/api/user', 1] };
    expect(summarizeSWREntry('@"/api/user",1,', user, 42)).toEqual({
      key: '@"/api/user",1,',
      label: '["/api/user",1]',
      kind: 'swr',
      status: 'success',
      fetching: true,
      updatedAt: 42,
      preview: '{id, name, email, …}',
    });
    expect(summarizeSWREntry('$inf$/api/list?page=0', { data: [[1], [2]], _k: '$inf$/api/list?page=0', _l: 2 })).toMatchObject({
      label: '/api/list?page=0',
      kind: 'swr-infinite',
      preview: 'Array(2)',
    });
    expect(summarizeSWREntry('$sub$ws://feed', { data: 'x'.repeat(80), error: undefined })).toMatchObject({
      label: 'ws://feed',
      kind: 'swr-subscription',
      preview: 'string(80)',
    });
    const notFound = Object.assign(new Error('Not found'), { status: 404 });
    expect(summarizeSWREntry('/api/x', { data: new Map([[1, 2]]), error: notFound, isValidating: false })).toMatchObject({
      status: 'error',
      error: 'Error: Not found (status 404)',
      preview: 'Map(1)',
    });
    expect(summarizeSWREntry('/api/y', { isValidating: true, isLoading: true })).toEqual({
      key: '/api/y',
      label: '/api/y',
      kind: 'swr',
      status: 'pending',
      fetching: true,
    });
    // What `clear` leaves: the entry stays, without data.
    expect(summarizeSWREntry('/api/z', { data: undefined, error: undefined, _c: undefined })).toEqual({
      key: '/api/z',
      label: '/api/z',
      kind: 'swr',
      status: 'idle',
      fetching: false,
    });
    const cyclic: unknown[] = ['/api/c'];
    cyclic.push(cyclic);
    expect(summarizeSWREntry('@"/api/c",1~,', { data: new Date(0), _k: cyclic })).toMatchObject({
      label: '@"/api/c",1~,',
      preview: 'Date',
    });
  });

  it('previews the shape of the data and of odd errors, never a value', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbm4ifQ.c2lnbmF0dXJl';
    const apiKey = 'sk_live_51HsecretKEY';
    class Session {
      token = token;
    }
    const shapes: Array<[unknown, string]> = [
      [token, `string(${token.length})`],
      [{ token, user: { email: 'ann@example.com' } }, '{token, user}'],
      [{ [token]: 1, 'ann@example.com': 2, [apiKey]: 3, '7d9f3c2e-1b4a-4f6e-9c3d-2a1b0c9d8e7f': 4 }, '{…}'],
      [{ id: 1, [apiKey]: 2 }, '{id, …}'],
      [[token, apiKey], 'Array(2)'],
      [new Map([[token, apiKey]]), 'Map(1)'],
      [new Session(), 'Session {token}'],
      [4_111_111_111_111_111, 'number'],
      [true, 'boolean'],
      [BigInt('9007199254740993'), 'bigint'],
      [new Date('2026-10-18T00:00:00Z'), 'Date'],
      [() => token, 'function'],
    ];
    for (const [data, shape] of shapes) {
      const summary = summarizeSWREntry('/api/session', { data, error: { token, status: 401 } });
      expect(summary).toMatchObject({ preview: shape, error: '{token, status} (status 401)' });
      expect(JSON.stringify(summary)).not.toMatch(/eyJ|sk_live|ann@|7d9f|4111|9007|2026|true/);
    }
  });

  it('leaves out entries holding only SWR internals', () => {
    expect(summarizeSWREntry('/api/save', { _c: undefined })).toBeUndefined();
    expect(summarizeSWREntry('/api/idle', { _k: '/api/idle' })).toBeUndefined();
    expect(summarizeSWREntry('/api/none', undefined)).toBeUndefined();
  });

  it('works from its source alone, as the Metro bridge will run it inside apps', () => {
    const app = vm.createContext({});
    const inApp = vm.runInContext(`(${summarizeSWREntry})`, app) as typeof summarizeSWREntry;
    const entry = vm.runInContext(
      `({ data: [{ id: 1 }], error: Object.assign(new TypeError('Failed to fetch'), { status: 503 }), isValidating: false, _k: ['/api/list', { page: 2 }] })`,
      app,
    );
    expect(JSON.parse(JSON.stringify(inApp('@"/api/list",#page:2,,', entry, 7)))).toEqual({
      key: '@"/api/list",#page:2,,',
      label: '["/api/list",{"page":2}]',
      kind: 'swr',
      status: 'error',
      fetching: false,
      updatedAt: 7,
      error: 'TypeError: Failed to fetch (status 503)',
      preview: 'Array(1)',
    });
  });
});

describe('watchSWR', () => {
  it('shows the default cache, labelled "default", once a client attaches', async () => {
    vi.setSystemTime(1_000);
    const { of, commands } = harness();
    watch(SWRConfig);
    expect(of('state.store')).toEqual([
      { store: { id: 'swr:1', library: 'swr', label: 'default', via: 'cache', actions: false, ops: ['revalidate', 'clear', 'reset'] } },
    ]);
    await mutate('/api/user', { id: 1, name: 'Ann' });
    expect(of('state.entries')).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    const user = { key: '/api/user', label: '/api/user', kind: 'swr', status: 'success', fetching: false, updatedAt: 1_000, preview: '{id, name}' };
    expect(of('state.entries')).toEqual([{ store: 'swr:1', upserts: [user], removed: [], reset: true }]);

    vi.setSystemTime(5_000);
    await mutate('/api/user', { id: 1, name: 'Bob' });
    await vi.advanceTimersByTimeAsync(200);
    expect(of('state.entries')[1]).toEqual({ store: 'swr:1', upserts: [{ ...user, updatedAt: 5_000 }], removed: [] });
    expect(commands.entry!({ store: 'swr:1', key: '/api/user' })).toEqual({
      summary: { ...user, updatedAt: 5_000 },
      data: { id: 1, name: 'Bob' },
      truncated: false,
    });
  });

  it('says when no hook can revalidate a key, and clears its data while keeping the entry', async () => {
    const { commands } = harness();
    watch(SWRConfig);
    await mutate('/api/todos', ['milk']);
    await expect(commands.act!({ store: 'swr:1', key: '/api/todos', op: 'revalidate' })).resolves.toEqual({
      done: false,
      note: 'No mounted hook fetches this key, so nothing was revalidated',
    });
    await expect(commands.act!({ store: 'swr:1', key: '/api/todos', op: 'clear' })).resolves.toEqual({ done: true });
    expect(defaultCache.get('/api/todos')).toMatchObject({ data: undefined });
    expect(commands.entries!({ store: 'swr:1' })).toEqual({
      entries: [{ key: '/api/todos', label: '/api/todos', kind: 'swr', status: 'idle', fetching: false, updatedAt: expect.any(Number) }],
      total: 1,
    });
    await mutate('/api/todos', ['eggs']);
    await expect(commands.act!({ store: 'swr:1', key: '/api/todos', op: 'reset' })).resolves.toEqual({
      done: true,
      note: 'Cleared; no mounted hook fetched it again',
    });
    expect(defaultCache.get('/api/todos')).toMatchObject({ data: undefined });
  });

  it('reports removed keys, and once untracked stops and gives the cache its own methods back', async () => {
    const { of } = harness();
    const untrack = watch(SWRConfig);
    expect(Object.getOwnPropertyDescriptor(defaultCache, 'set')?.value).toBeTypeOf('function');
    await mutate('/api/a', 1);
    await vi.advanceTimersByTimeAsync(200);
    unload({ revalidate: false });
    await vi.advanceTimersByTimeAsync(200);
    expect(of('state.entries').at(-1)).toEqual({ store: 'swr:1', upserts: [], removed: ['/api/a'] });

    untrack();
    expect(of('state.store').at(-1)).toEqual({ store: expect.objectContaining({ id: 'swr:1', disposed: true }) });
    expect(Object.getOwnPropertyDescriptor(defaultCache, 'set')).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(defaultCache, 'delete')).toBeUndefined();
    await mutate('/api/b', 2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(of('state.entries')).toHaveLength(2);
  });

  it('patches a cache only while a client runs', () => {
    const cache = new Map<string, unknown>();
    watch({ cache });
    expect(Object.getOwnPropertyDescriptor(cache, 'set')).toBeUndefined();
    const { teardown } = harness();
    expect(Object.getOwnPropertyDescriptor(cache, 'set')?.value).toBeTypeOf('function');
    teardown();
    expect(Object.getOwnPropertyDescriptor(cache, 'set')).toBeUndefined();
    harness();
    expect(Object.getOwnPropertyDescriptor(cache, 'delete')?.value).toBeTypeOf('function');
  });

  it('takes a cache with its mutate, names caches, and fills in a mutate it learns later', async () => {
    const { of, commands } = harness();
    const persisted = new Map();
    watch({ cache: persisted }, { name: 'persisted' });
    watch({ cache: new Map() });
    watch(SWRConfig, { name: 'main' });
    expect(of('state.store').map((e) => e.store.label)).toEqual(['persisted', expect.stringMatching(/^cache #\d+$/), 'main']);
    persisted.set('/api/a', { data: 1 });
    await expect(commands.act!({ store: 'swr:1', key: '/api/a', op: 'clear' })).resolves.toEqual({
      done: false,
      note: 'Capybara has no mutate() for this cache yet: add swrMiddleware to the SWRConfig that creates it',
    });

    const scoped = vi.fn(async () => undefined);
    watch({ cache: persisted, mutate: scoped }, { name: 'ignored' });
    expect(of('state.store')).toHaveLength(3);
    await expect(commands.act!({ store: 'swr:1', key: '/api/a', op: 'clear' })).resolves.toEqual({ done: true });
    expect(scoped).toHaveBeenCalledWith('/api/a', undefined, { revalidate: false });
  });

  it('never throws into the app: bad targets, a frozen cache, a proxy that keeps its methods', () => {
    const { of } = harness();
    expect(watchSWR(null as never)).toBeTypeOf('function');
    expect(watchSWR({ cache: {} } as never)).toBeTypeOf('function');
    expect(of('state.store')).toEqual([]);
    const frozen = Object.freeze(new Map<string, unknown>());
    expect(() => watch({ cache: frozen })).not.toThrow();
    expect(of('state.store').at(-1)).toEqual({
      store: expect.objectContaining({ disposed: true, note: expect.stringContaining('Could not watch this store') }),
    });
    expect(frozen.set).toBe(Map.prototype.set);

    const map = new Map<string, unknown>();
    const proxy = new Proxy(map, {
      defineProperty: () => true,
      get: (target, name) => {
        const value = Reflect.get(target, name, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    watch({ cache: proxy });
    expect(of('state.store').at(-1)).toEqual({
      store: expect.objectContaining({ disposed: true, note: "Could not watch this store: Could not patch the cache's set()" }),
    });
  });

  it('does nothing on the server, and keeps no registry there', () => {
    vi.stubGlobal('window', undefined);
    expect(typeof window).toBe('undefined');
    const cache = new Map();
    expect(watchSWR({ cache })).toBeTypeOf('function');
    expect(swrProvider(() => cache)(defaultCache)).toBe(cache);
    expect(swrProvider()(cache)).toBe(cache);
    const next = vi.fn(() => 'response');
    expect(swrMiddleware(next)('/api/a', null, { cache })).toBe('response');
    expect(next).toHaveBeenCalledWith('/api/a', null, { cache });
    expect(Object.getOwnPropertyDescriptor(cache, 'set')).toBeUndefined();
    expect(REGISTRY_GLOBAL in globalThis).toBe(false);
  });
});

describe('the cache patch', () => {
  it('lets the write land first, and never lets a failure reach the app', () => {
    const cache = new Map<string, unknown>();
    const seen: unknown[] = [];
    registered({ cache }).start({ ...quiet, dirty: (_, key) => void seen.push(cache.get(key)) });
    expect(cache.set('/a', { data: 1 })).toBe(cache);
    expect(seen).toEqual([{ data: 1 }]);

    const broken = new Map<string, unknown>();
    const fail = () => {
      throw new Error('sink broke');
    };
    registered({ cache: broken }).start({ record: fail, dirty: fail, removed: fail });
    expect(() => broken.set('/b', { data: 2 })).not.toThrow();
    expect(broken.get('/b')).toEqual({ data: 2 });
    expect(() => broken.delete('/b')).not.toThrow();
    expect(broken.has('/b')).toBe(false);

    // The cache's own failure still reaches its caller, as without Capybara.
    const full = { keys: () => new Map().keys(), get: () => undefined, set: () => fail(), delete: () => {} };
    registered({ cache: full }).start(quiet);
    expect(() => full.set()).toThrow('sink broke');
  });

  it('dates an entry by when its data or error last changed', () => {
    const cache = new Map<string, unknown>([['/old', { data: 0 }]]);
    const { driver, start } = registered({ cache });
    start(quiet);
    const data = { id: 1 };
    vi.setSystemTime(1_000);
    cache.set('/a', { data });
    vi.setSystemTime(2_000);
    cache.set('/a', { data, isValidating: true });
    expect(driver.summarize!('/a')).toMatchObject({ updatedAt: 1_000, fetching: true });
    vi.setSystemTime(3_000);
    cache.set('/a', { data, error: new Error('down'), isValidating: false });
    expect(driver.summarize!('/a')).toMatchObject({ updatedAt: 3_000, status: 'error' });
    expect(driver.summarize!('/old')).not.toHaveProperty('updatedAt');
  });

  it('lists at most 1000 keys: those written to last, then the newest, in cache order', () => {
    const cache = new Map<string, unknown>();
    for (let i = 0; i < 1_500; i++) cache.set(`/k/${i}`, { data: i });
    cache.set('/mutation', { _c: undefined });
    const { driver, start } = registered({ cache });
    start(quiet);
    cache.set('/k/3', { data: 'again' });
    const keys = [...driver.keys!()];
    expect(keys).toHaveLength(1_000);
    expect(keys.slice(0, 2)).toEqual(['/k/3', '/k/501']);
    expect(keys.at(-1)).toBe('/k/1499');
    expect(keys).not.toContain('/mutation');
  });

  it('leaves a patch stacked on its own working when it stops, and reuses its own when it starts again', () => {
    const cache = new Map<string, unknown>();
    const heard: string[] = [];
    const { start } = registered({ cache });
    const sink = { ...quiet, dirty: (_: string, key: string) => void heard.push(key) };
    let stop = start(sink);
    const ours = cache.set;
    // As swr-devtools does: patch the instance, calling the method it found.
    const devtools: string[] = [];
    const theirs = function (this: Map<string, unknown>, key: string, value: unknown) {
      devtools.push(key);
      return ours.call(this, key, value);
    };
    cache.set = theirs;
    stop();
    expect(cache.set).toBe(theirs);
    cache.set('/a', { data: 1 });
    expect(devtools).toEqual(['/a']);
    expect(cache.get('/a')).toEqual({ data: 1 });
    expect(heard).toEqual([]);

    stop = start(sink);
    expect(cache.set).toBe(theirs);
    cache.set('/b', { data: 2 });
    expect(heard).toEqual(['/b']);
    stop();
    // The other tool puts back what it found; ours is then on top and comes off.
    cache.set = ours;
    start(sink)();
    expect(Object.getOwnPropertyDescriptor(cache, 'set')).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(cache, 'delete')).toBeUndefined();
  });
});

describe('watchSWR with React', () => {
  it('revalidates and resets through a mounted hook', async () => {
    const { commands, of } = harness();
    watch(SWRConfig);
    const fetcher = counter();
    const view = await render(createElement(Fetch, { id: '/api/me', fetcher }));
    expect(view.textContent).toBe('{"key":"/api/me","n":1}');

    expect(await act(() => commands.act!({ store: 'swr:1', key: '/api/me', op: 'revalidate' }))).toEqual({ done: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(view.textContent).toBe('{"key":"/api/me","n":2}');
    expect(await act(() => commands.act!({ store: 'swr:1', key: '/api/me', op: 'reset' }))).toEqual({ done: true });
    expect(view.textContent).toBe('{"key":"/api/me","n":3}');

    await vi.advanceTimersByTimeAsync(200);
    expect(of('state.entries').at(-1).upserts).toEqual([
      expect.objectContaining({ key: '/api/me', status: 'success', fetching: false, preview: '{key, n}' }),
    ]);
  });

  it('answers a revalidate once its fetch settles, or after 10 seconds', async () => {
    const { commands } = harness();
    watch(SWRConfig);
    const pending: Array<(data: string) => void> = [];
    const fetcher = vi.fn((key: string) =>
      fetcher.mock.calls.length === 1 ? Promise.resolve(key) : new Promise<string>((resolve) => pending.push(resolve)),
    );
    const view = await render(createElement(Fetch, { id: '/api/slow', fetcher }));
    const answers: unknown[] = [];
    const revalidate = () =>
      act(async () => {
        void commands.act!({ store: 'swr:1', key: '/api/slow', op: 'revalidate' }).then((answer: unknown) => answers.push(answer));
      });

    await revalidate();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(answers).toEqual([]);
    await act(async () => pending[0]!('fresh'));
    expect(answers).toEqual([{ done: true }]);
    expect(view.textContent).toBe('"fresh"');

    await revalidate();
    await act(() => vi.advanceTimersByTimeAsync(9_999));
    expect(answers).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(answers).toEqual([{ done: true }, { done: true }]);
  });

  it('shows infinite and subscription keys, and hides what useSWRMutation leaves behind', async () => {
    const { commands } = harness();
    watch(SWRConfig);
    let save: (arg: string) => Promise<unknown> = async () => undefined;
    function Screen() {
      useSWRInfinite((index) => `/api/list?page=${index}`, async (key: string) => [key], { initialSize: 2 });
      useSWRSubscription('ws://feed', (_key: string, { next }: { next: (error: unknown, data: string) => void }) => {
        next(null, 'hello');
        return () => {};
      });
      useSWR(['/api/user', 1], async () => ({ id: 1 }));
      save = useSWRMutation('/api/save', async (_key: string, { arg }: { arg: string }) => arg).trigger;
      return null;
    }
    await render(createElement(Screen));
    await act(() => save('draft'));
    expect(defaultCache.get('/api/save')).toEqual({ _c: undefined });

    const { entries, total } = commands.entries!({ store: 'swr:1' });
    expect(total).toBe(5);
    expect(entries.map((e: { key: string; label: string; kind: string }) => [e.key, e.label, e.kind])).toEqual(
      expect.arrayContaining([
        ['$inf$/api/list?page=0', '/api/list?page=0', 'swr-infinite'],
        ['/api/list?page=0', '/api/list?page=0', 'swr'],
        ['/api/list?page=1', '/api/list?page=1', 'swr'],
        ['$sub$ws://feed', 'ws://feed', 'swr-subscription'],
        ['@"/api/user",1,', '["/api/user",1]', 'swr'],
      ]),
    );
    expect(entries.find((e: { key: string }) => e.key === '$inf$/api/list?page=0')).toMatchObject({ status: 'success', preview: 'Array(2)' });
    expect(entries.find((e: { key: string }) => e.key === '$sub$ws://feed')).toMatchObject({ status: 'success', preview: 'string(5)' });
    expect(await act(() => commands.act!({ store: 'swr:1', key: '$sub$ws://feed', op: 'revalidate' }))).toMatchObject({ done: false });
  });

  it('shows a failed fetch with its status', async () => {
    const { commands } = harness();
    watch(SWRConfig);
    const fetcher = async () => {
      throw Object.assign(new Error('Not found'), { status: 404 });
    };
    const view = await render(createElement(Fetch, { id: '/api/missing', fetcher }));
    expect(view.textContent).toBe('error: Not found');
    expect(commands.entries!({ store: 'swr:1' }).entries).toEqual([
      expect.objectContaining({ key: '/api/missing', status: 'error', fetching: false, error: 'Error: Not found (status 404)' }),
    ]);
  });

  it('keeps up with Suspense, which writes to the cache during render', async () => {
    let rendering = false;
    const duringRender: string[] = [];
    const { driver, start } = registered(SWRConfig);
    start({ ...quiet, dirty: (_, key) => void (rendering && duringRender.push(key)) });
    const errors = vi.spyOn(console, 'error');
    cleanups.push(() => errors.mockRestore());
    function Profile() {
      rendering = true;
      try {
        const { data } = useSWR('/api/profile', async () => ({ name: 'Ann' }), { suspense: true });
        return createElement('b', null, data.name);
      } finally {
        rendering = false;
      }
    }
    const view = await render(createElement(Suspense, { fallback: 'loading' }, createElement(Profile)));
    expect(view.textContent).toBe('Ann');
    expect(duringRender).toContain('/api/profile');
    expect(driver.summarize!('/api/profile')).toMatchObject({ status: 'success', fetching: false, preview: '{name}' });
    expect(errors).not.toHaveBeenCalled();
  });

  it('watches the cache of an SWRConfig provider through swrMiddleware, which also brings its mutate', async () => {
    const { commands, of } = harness();
    const made: Array<Map<string, unknown>> = [];
    const provider = () => {
      const cache = new Map<string, unknown>();
      made.push(cache);
      return cache;
    };
    const fetcher = counter();
    const view = await render(createElement(SWRConfig, { value: { provider, use: [swrMiddleware] } }, createElement(Fetch, { id: '/api/rn', fetcher })));
    expect(made).toHaveLength(1);
    const store = of('state.store')[0].store;
    expect(store.label).toMatch(/^cache #\d+$/);
    expect(defaultCache.has('/api/rn')).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(of('state.entries')[0]).toMatchObject({ reset: true, upserts: [expect.objectContaining({ key: '/api/rn', status: 'success' })] });

    expect(await act(() => commands.act!({ store: store.id, key: '/api/rn', op: 'revalidate' }))).toEqual({ done: true });
    expect(view.textContent).toBe('{"key":"/api/rn","n":2}');
    expect(of('state.store')).toHaveLength(1);
  });

  it('patches the very cache swrProvider returns, once, however often SWR asks for it', async () => {
    const { of } = harness();
    const appCache = new Map<string, unknown>();
    const provider = swrProvider(() => appCache, { name: 'app' });
    expect(provider(defaultCache)).toBe(appCache);
    const patched = Object.getOwnPropertyDescriptor(appCache, 'set')?.value;
    expect(patched).toBeTypeOf('function');
    expect(provider(defaultCache)).toBe(appCache);
    expect(Object.getOwnPropertyDescriptor(appCache, 'set')?.value).toBe(patched);
    // Without its own provider, it watches the parent cache.
    const parent = new Map<string, unknown>();
    expect(swrProvider()(parent)).toBe(parent);
    expect(Object.getOwnPropertyDescriptor(parent, 'set')?.value).toBeTypeOf('function');

    let scoped: ((...args: unknown[]) => Promise<unknown>) | undefined;
    function Scope() {
      scoped = useSWRConfig().mutate as typeof scoped;
      return createElement(Fetch, { id: '/api/app', fetcher: counter() });
    }
    const view = await render(createElement(StrictMode, null, createElement(SWRConfig, { value: { provider } }, createElement(Scope))));
    expect(view.textContent).toBe('{"key":"/api/app","n":1}');
    // Hooks and the scope's mutate still share the one cache.
    await act(() => scoped!('/api/app', { key: '/api/app', n: 9 }, { revalidate: false }));
    expect(view.textContent).toBe('{"key":"/api/app","n":9}');
    expect(appCache.get('/api/app')).toMatchObject({ data: { n: 9 } });
    expect(of('state.store').map((e) => e.store.label)).toEqual(['app', expect.stringMatching(/^cache #\d+$/)]);
    await vi.advanceTimersByTimeAsync(200);
    const app = of('state.entries').filter((e) => e.store === of('state.store')[0].store.id);
    expect(app.at(-1).upserts).toEqual([expect.objectContaining({ key: '/api/app', preview: '{key, n}' })]);
  });
});
