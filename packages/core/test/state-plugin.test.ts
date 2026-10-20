import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StateEntrySummary, StateLibrary } from '@capybara-devtools/protocol';
import {
  CLIENT_GLOBAL,
  createClient,
  getActiveClient,
  serialize,
  statePlugin,
  type PluginContext,
  type StatePluginOptions,
  type StateSink,
  type StoreDriver,
} from '../src/index.js';
import { REGISTRY_GLOBAL, register, unregister } from '../src/plugins/state/registry.js';
import type { SocketLike } from '../src/transport.js';

type Recorded = { kind: string; payload: any };

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: any[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  events(kind?: string) {
    const all = this.sent.filter((m) => m.t === 'events').flatMap((m) => m.events);
    return kind ? all.filter((e: Recorded) => e.kind === kind) : all;
  }
}

/** A store that reports each change with the action that made it, like Redux. */
function fakeStore<T>(label: string, initial: T, library: StateLibrary = 'zustand') {
  let state = initial;
  const listeners = new Set<(action?: unknown) => void>();
  const driver: StoreDriver = {
    info: { library, label, via: 'subscribe', actions: true },
    getState: () => state,
    start(sink, id) {
      const listener = (action?: unknown) => sink.record(id, state, action);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    driver,
    listeners,
    dispatch(next: T, action?: unknown) {
      state = next;
      for (const listener of listeners) listener(action);
    },
  };
}

/** A cache with entries, like TanStack Query. */
function fakeCache() {
  const data = new Map<string, { status: StateEntrySummary['status']; value: unknown }>([
    ['a', { status: 'success', value: { list: [1, 2] } }],
  ]);
  const acted: string[] = [];
  let sink: StateSink | undefined;
  let id = '';
  const driver: StoreDriver = {
    info: { library: 'tanstack-query', label: 'client', via: 'client', actions: false, ops: ['refetch'] },
    keys: () => data.keys(),
    summarize: (key) => {
      const entry = data.get(key);
      return entry && { key, label: key, kind: 'query', status: entry.status, fetching: false };
    },
    data: (key) => data.get(key)?.value,
    act: async (key, op) => {
      acted.push(`${op}:${key}`);
      return { done: true };
    },
    start(s, i) {
      sink = s;
      id = i;
    },
  };
  return {
    driver,
    acted,
    set(key: string, status: StateEntrySummary['status'], value: unknown, low = false) {
      data.set(key, { status, value });
      sink?.dirty(id, key, low);
    },
    remove(key: string) {
      data.delete(key);
      sink?.removed(id, key);
    },
  };
}

function harness(options: StatePluginOptions = {}) {
  const events: Recorded[] = [];
  const ctx: PluginContext = { emit: (kind, payload) => events.push({ kind, payload }), serialize, console };
  const plugin = statePlugin(options);
  const teardown = plugin.setup!(ctx) as () => void;
  const of = (kind: string) => events.filter((e) => e.kind === kind).map((e) => e.payload);
  return { commands: plugin.commands!, events, of, teardown };
}

/** The engine reads the connection from the active client; the harness has none, so fake one. */
const online = () => vi.stubGlobal(CLIENT_GLOBAL, { connected: true });

function connect() {
  const sockets: FakeSocket[] = [];
  const client = createClient({
    url: 'ws://test/client',
    session: { appName: 'Test', platform: 'web', sdk: { name: 'test', version: '0' } },
    plugins: [statePlugin()],
    flushInterval: 0,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  return { client, sockets };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', globalThis);
});

afterEach(() => {
  vi.unstubAllGlobals();
  getActiveClient()?.stop();
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>)[REGISTRY_GLOBAL];
});

describe('statePlugin', () => {
  it('announces stores registered before it starts and after, then records their changes', () => {
    online();
    const cart = fakeStore('cart', { items: [] as string[] });
    expect(register(cart.driver)).toBe('zustand:1');
    const { of } = harness();
    const session = fakeStore('session', { user: null as string | null }, 'redux');
    expect(register(session.driver)).toBe('redux:1');
    expect(of('state.store')).toEqual([
      { store: { id: 'zustand:1', library: 'zustand', label: 'cart', via: 'subscribe', actions: true } },
      { store: { id: 'redux:1', library: 'redux', label: 'session', via: 'subscribe', actions: true } },
    ]);

    cart.dispatch({ items: ['apple'] }, { type: 'cart/add', payload: 'apple' });
    session.dispatch({ user: 'ann' });
    expect(of('state.change')).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(of('state.change')).toEqual([
      {
        store: 'zustand:1',
        rev: 1,
        cause: 'action',
        action: { type: 'cart/add', payload: { payload: 'apple' } },
        ops: [{ op: 'add', path: ['items', 0], value: 'apple' }],
      },
      { store: 'redux:1', rev: 1, cause: 'set', ops: [{ op: 'set', path: ['user'], value: 'ann', prev: null }] },
    ]);
  });

  it('reads the state by path, with the latest rev and whether changes are still pending', () => {
    online();
    const counter = fakeStore('counter', { count: 0, nested: { deep: [1, 2] } });
    const id = register(counter.driver)!;
    const { commands } = harness();
    counter.dispatch({ count: 1, nested: { deep: [1, 2] } }, { type: 'inc' });
    expect(commands.get!({ store: id })).toMatchObject({ rev: 0, pending: true, value: { count: 1 }, truncated: false });
    vi.advanceTimersByTime(100);
    expect(commands.get!({ store: id, path: ['nested', 'deep'] })).toEqual({ rev: 1, pending: false, value: [1, 2], truncated: false });
    expect(() => commands.get!({ store: id, path: ['missing'] })).toThrow('Nothing at ["missing"]');
    expect(() => commands.get!({ store: 'redux:9' })).toThrow('Unknown store "redux:9"');
  });

  it('folds a burst past the rate limit into the last record, which ends on the newest state', () => {
    online();
    const counter = fakeStore('counter', { count: 0 });
    register(counter.driver);
    const { of } = harness();
    for (let i = 1; i <= 1_000; i++) counter.dispatch({ count: i }, { type: 'inc' });
    vi.advanceTimersByTime(1_000);

    const changes = of('state.change');
    expect(changes.length).toBeLessThanOrEqual(30);
    expect(changes.map((c) => c.rev)).toEqual(changes.map((_, i) => i + 1));
    expect(changes.reduce((sum, c) => sum + 1 + (c.skipped ?? 0), 0)).toBe(1_000);
    expect(changes.at(-1)).toMatchObject({ skipped: expect.any(Number), ops: [{ op: 'set', path: ['count'], value: 1_000 }] });
    vi.advanceTimersByTime(5_000);
    expect(of('state.change')).toHaveLength(changes.length);
  });

  it('holds changes past the limit until the next second', () => {
    online();
    const counter = fakeStore('counter', { count: 0 });
    const id = register(counter.driver)!;
    const { of } = harness({ maxActionsPerSecond: 2 });
    counter.dispatch({ count: 1 }, { type: 'a' });
    counter.dispatch({ count: 2 }, { type: 'b' });
    vi.advanceTimersByTime(100);
    expect(of('state.change').map((c) => c.action.type)).toEqual(['a', 'b']);

    counter.dispatch({ count: 3 }, { type: 'c' });
    counter.dispatch({ count: 4 }, { type: 'd' });
    vi.advanceTimersByTime(500);
    expect(of('state.change')).toHaveLength(2);
    vi.advanceTimersByTime(500);
    expect(of('state.change').slice(2)).toEqual([
      { store: id, rev: 3, cause: 'action', action: { type: 'd' }, ops: [{ op: 'set', path: ['count'], value: 4, prev: 2 }], skipped: 1 },
    ]);
  });
});

describe('statePlugin with failing drivers and many stores', () => {
  it('never lets a failing driver throw into the app', () => {
    online();
    const { of, commands } = harness();
    let notify = () => {};
    const broken: StoreDriver = {
      info: { library: 'redux', label: 'broken', via: 'enhancer', actions: true },
      getState() {
        throw new Error('reducer is running');
      },
      start(sink, id) {
        notify = () => sink.record(id, { ok: true }, { type: 'ping' });
      },
    };
    const id = register(broken)!;
    expect(() => notify()).not.toThrow();
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    // Without a state to start from, the first record replaces the whole state.
    expect(of('state.change')).toEqual([
      { store: id, rev: 1, cause: 'action', action: { type: 'ping' }, ops: [{ op: 'set', path: [], value: { ok: true } }] },
    ]);
    expect(() => commands.get!({ store: id })).toThrow('reducer is running');

    const frozen: StoreDriver = {
      info: { library: 'swr', label: 'frozen', via: 'cache', actions: false },
      keys: () => [],
      start() {
        throw new Error('cache is frozen');
      },
    };
    let other: string | undefined;
    expect(() => (other = register(frozen))).not.toThrow();
    expect(of('state.store').at(-1)).toEqual({
      store: { id: other, library: 'swr', label: 'frozen', via: 'cache', actions: false, disposed: true, note: 'Could not watch this store: cache is frozen' },
    });
  });

  it('keeps three instances per label and disposes the oldest', () => {
    online();
    const { of, commands } = harness();
    const carts = [1, 2, 3, 4].map(() => fakeStore('cart', {}));
    expect(carts.map((cart) => register(cart.driver))).toEqual(['zustand:1', 'zustand:2', 'zustand:3', 'zustand:4']);
    expect(of('state.store').filter((e) => e.store.disposed)).toEqual([
      { store: { id: 'zustand:1', library: 'zustand', label: 'cart', via: 'subscribe', actions: true, disposed: true } },
    ]);
    expect(carts.map((cart) => cart.listeners.size)).toEqual([0, 1, 1, 1]);
    expect(commands.stores!(undefined).map((s: { id: string }) => s.id)).toEqual(['zustand:2', 'zustand:3', 'zustand:4']);
  });

  it('registers a target once, again after it is unregistered, and never without a window', () => {
    const store = {};
    const first = register(fakeStore('a', 0).driver, store);
    expect(register(fakeStore('a', 0).driver, store)).toBe(first);
    unregister(first!);
    expect(register(fakeStore('a', 0).driver, store)).toBe('zustand:2');

    vi.unstubAllGlobals();
    expect(typeof window).toBe('undefined');
    expect(register(fakeStore('b', 0).driver)).toBeUndefined();
  });

  it('shares stores with a second copy of the SDK in the same bundle', async () => {
    online();
    const cart = fakeStore('cart', { n: 0 });
    const id = register(cart.driver);
    vi.resetModules();
    const copy = await import('../src/plugins/state/index.js');
    const copyRegistry = await import('../src/plugins/state/registry.js');
    expect(copyRegistry.register).not.toBe(register);

    const events: Recorded[] = [];
    const ctx: PluginContext = { emit: (kind, payload) => events.push({ kind, payload }), serialize, console };
    const teardown = copy.statePlugin().setup!(ctx) as () => void;
    expect(events).toEqual([{ kind: 'state.store', payload: { store: expect.objectContaining({ id }) } }]);
    cart.dispatch({ n: 1 }, { type: 'inc' });
    vi.advanceTimersByTime(100);
    expect(events.at(-1)).toMatchObject({ kind: 'state.change', payload: { store: id, rev: 1 } });
    expect(copyRegistry.register(fakeStore('cart', {}).driver)).toBe('zustand:2');
    teardown();
  });
});

describe('statePlugin options and entries', () => {
  it('sanitizes before diffing, keeps denylisted actions off the timeline and hides functions', () => {
    online();
    const auth = fakeStore('auth', { token: 'secret', user: 'ann', logout: () => {} });
    const id = register(auth.driver)!;
    const { of, commands } = harness({
      actionsDenylist: ['tick', /^@@/],
      sanitizeState: (state) => ({ ...(state as object), token: '[hidden]' }),
      sanitizeAction: (action) => ({ ...(action as object), password: '[hidden]' }),
    });
    auth.dispatch({ token: 'secret2', user: 'ann', logout: () => {} }, { type: 'tick' });
    auth.dispatch({ token: 'secret2', user: 'ann', logout: () => {} }, { type: '@@redux/PING' });
    auth.dispatch({ token: 'secret3', user: 'bob', logout: () => {} }, { type: 'login', password: 'hunter2' });
    vi.advanceTimersByTime(100);
    expect(of('state.change')).toEqual([
      {
        store: id,
        rev: 1,
        cause: 'action',
        action: { type: 'login', payload: { password: '[hidden]' } },
        ops: [{ op: 'set', path: ['user'], value: 'bob', prev: 'ann' }],
      },
    ]);
    expect(commands.get!({ store: id }).value).toEqual({ token: '[hidden]', user: 'bob' });
  });

  it('never sends a state its sanitizer failed on', () => {
    online();
    const auth = fakeStore('auth', { token: 'secret' });
    const id = register(auth.driver)!;
    const { of, commands } = harness({
      sanitizeState: () => {
        throw new Error('bad sanitizer');
      },
    });
    auth.dispatch({ token: 'secret2' }, { type: 'refresh' });
    vi.advanceTimersByTime(100);
    expect(JSON.stringify(of('state.change'))).not.toContain('secret');
    expect(() => commands.get!({ store: id })).toThrow('bad sanitizer');
  });

  it('sends entry summaries: a reset first, then only what changed, low priority a second later', async () => {
    online();
    const cache = fakeCache();
    const id = register(cache.driver)!;
    const { of, commands } = harness();
    const summary = (key: string, status: StateEntrySummary['status']) => ({ key, label: key, kind: 'query', status, fetching: false });
    vi.advanceTimersByTime(200);
    expect(of('state.entries')).toEqual([{ store: id, upserts: [summary('a', 'success')], removed: [], reset: true }]);

    cache.set('b', 'pending', null);
    cache.set('a', 'success', { list: [1, 2] });
    vi.advanceTimersByTime(200);
    expect(of('state.entries').slice(1)).toEqual([{ store: id, upserts: [summary('b', 'pending')], removed: [] }]);

    cache.set('b', 'success', 'done', true);
    vi.advanceTimersByTime(200);
    expect(of('state.entries')).toHaveLength(2);
    vi.advanceTimersByTime(800);
    expect(of('state.entries')[2]).toEqual({ store: id, upserts: [summary('b', 'success')], removed: [] });

    cache.remove('a');
    vi.advanceTimersByTime(200);
    expect(of('state.entries')[3]).toEqual({ store: id, upserts: [], removed: ['a'] });

    expect(commands.entries!({ store: id })).toEqual({ entries: [summary('b', 'success')], total: 1 });
    expect(commands.entry!({ store: id, key: 'b' })).toEqual({ summary: summary('b', 'success'), data: 'done', truncated: false });
    expect(commands.entry!({ store: id, key: 'gone' })).toBeNull();
    await expect(commands.act!({ store: id, key: 'b', op: 'refetch' })).resolves.toEqual({ done: true });
    await expect(commands.act!({ store: id, key: 'b', op: 'remove' })).rejects.toThrow('client does not support "remove"');
    expect(cache.acted).toEqual(['refetch:b']);
    expect(() => commands.get!({ store: id })).toThrow('client has entries instead of a state');
  });

  it('sanitizes the data of an entry before it is read, and never sends it when the sanitizer fails', () => {
    online();
    const cache = fakeCache();
    const id = register(cache.driver)!;
    cache.set('me', 'success', { name: 'Ann', token: 'secret' });
    const seen: unknown[] = [];
    const { commands } = harness({
      sanitizeEntry: (data, entry) => {
        seen.push(entry);
        return { ...(data as object), token: '[hidden]' };
      },
    });
    expect(commands.entry!({ store: id, key: 'me', path: ['token'] })?.data).toBe('[hidden]');
    expect(seen).toEqual([{ store: expect.objectContaining({ id, library: 'tanstack-query' }), key: 'me' }]);
    const failing = harness({
      sanitizeEntry: () => {
        throw new Error('bad sanitizer');
      },
    });
    expect(failing.commands.entry!({ store: id, key: 'me' })?.data).toBe('[sanitizeEntry threw: bad sanitizer]');
  });
});

describe('statePlugin in a client', () => {
  it('keeps stores through stop() and a new client, and stops listening in between', () => {
    const cart = fakeStore('cart', { n: 0 });
    const id = register(cart.driver)!;
    const first = connect();
    expect(cart.listeners.size).toBe(1);
    first.client.stop();
    expect(cart.listeners.size).toBe(0);
    cart.dispatch({ n: 1 }, { type: 'while stopped' });

    const second = connect();
    expect(cart.listeners.size).toBe(1);
    const socket = second.sockets[0]!;
    socket.open();
    socket.receive({ t: 'welcome', lastSeq: 0 });
    cart.dispatch({ n: 2 }, { type: 'inc' });
    vi.advanceTimersByTime(100);
    // The client sends on its own timer.
    vi.runOnlyPendingTimers();
    expect(socket.events().map((e: Recorded) => e.kind)).toEqual(['state.store', 'state.change']);
    expect(socket.events('state.store')[0].payload.store).toMatchObject({ id, label: 'cart' });
    expect(socket.events('state.change')[0].payload).toEqual({
      store: id,
      rev: 1,
      cause: 'action',
      action: { type: 'inc' },
      ops: [{ op: 'set', path: ['n'], value: 2, prev: 1 }],
    });
  });

  it('sends no change before the welcome, then one catch-up record with what it skipped', () => {
    const counter = fakeStore('counter', { count: 0 });
    const id = register(counter.driver)!;
    const { client, sockets } = connect();
    for (let i = 1; i <= 3; i++) counter.dispatch({ count: i }, { type: 'inc' });
    vi.advanceTimersByTime(5_000);

    const socket = sockets[0]!;
    socket.open();
    socket.receive({ t: 'welcome', lastSeq: 0 });
    expect(socket.events().map((e: Recorded) => e.kind)).toEqual(['state.store']);
    vi.advanceTimersByTime(1_000);
    expect(client.connected).toBe(true);
    expect(socket.events('state.change').map((e: Recorded) => e.payload)).toEqual([
      { store: id, rev: 1, cause: 'action', action: { type: 'inc' }, ops: [{ op: 'set', path: ['count'], value: 3, prev: 0 }], skipped: 2 },
    ]);
  });

  it('dates each change by when it happened, not by when its batch went out', () => {
    const counter = fakeStore('counter', { count: 0 });
    register(counter.driver);
    const { sockets } = connect();
    const socket = sockets[0]!;
    socket.open();
    socket.receive({ t: 'welcome', lastSeq: 0 });
    vi.setSystemTime(10_000);
    counter.dispatch({ count: 1 }, { type: 'inc' });
    vi.setSystemTime(10_060);
    counter.dispatch({ count: 2 }, { type: 'inc' });
    vi.advanceTimersByTime(1_000);
    expect(socket.events('state.change').map((e: Recorded & { ts: number }) => e.ts)).toEqual([10_000, 10_060]);
  });
});
