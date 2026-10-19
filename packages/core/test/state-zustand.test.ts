import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJSONStorage, devtools, persist } from 'zustand/middleware';
import { createStore } from 'zustand/vanilla';
import { CLIENT_GLOBAL, serialize, statePlugin, type PluginContext, type StatePluginOptions } from '../src/index.js';
import { REGISTRY_GLOBAL } from '../src/plugins/state/registry.js';
import { watchZustand } from '../src/plugins/state/zustand.js';

type Recorded = { kind: string; payload: any };
type Counter = { count: number; add: () => void; reset: () => void };
type Cart = { items: string[]; add: (item: string) => void };

const scope = globalThis as Record<string, any>;
const teardowns: Array<() => void> = [];

function harness(options: StatePluginOptions = {}) {
  const events: Recorded[] = [];
  const ctx: PluginContext = { emit: (kind, payload) => events.push({ kind, payload }), serialize, console };
  const teardown = statePlugin(options).setup!(ctx) as () => void;
  teardowns.push(teardown);
  const of = (kind: string) => events.filter((e) => e.kind === kind).map((e) => e.payload);
  return { of, teardown };
}

/** A synchronous storage, so persist hydrates while the store is created. */
function memoryStorage(saved: Record<string, unknown> = {}) {
  const items = new Map(Object.entries(saved).map(([key, state]) => [key, JSON.stringify({ state, version: 0 })]));
  return createJSONStorage(() => ({
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  }));
}

/** Counts the stack traces built while `run` runs: V8 formats each through Error.prepareStackTrace. */
function stackTraces(run: () => void): number {
  let built = 0;
  const saved = Error.prepareStackTrace;
  Error.prepareStackTrace = (error, frames) => {
    built++;
    return `${error}\n${frames.map((frame) => `    at ${frame}`).join('\n')}`;
  };
  try {
    run();
  } finally {
    Error.prepareStackTrace = saved;
  }
  return built;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal(CLIENT_GLOBAL, { connected: true });
});

afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete scope[REGISTRY_GLOBAL];
});

describe('zustand devtools() through the shim', () => {
  it('shows a store created after init() with its action names, given or inferred', () => {
    const { of } = harness();
    const store = createStore<Counter>()(
      devtools(
        (set) => ({
          count: 0,
          add: () => set((state) => ({ count: state.count + 1 })),
          reset: () => set({ count: 0 }, false, 'counter/reset'),
        }),
        { name: 'Counter' },
      ),
    );
    store.getState().add();
    store.getState().reset();
    vi.advanceTimersByTime(100);

    expect(of('state.store')).toEqual([{ store: { id: 'zustand:1', library: 'zustand', label: 'Counter', via: 'shim', actions: true } }]);
    // Functions in the state, the store's actions, stay out of the diffs.
    expect(of('state.change')).toEqual([
      { store: 'zustand:1', rev: 1, cause: 'init', ops: [] },
      {
        store: 'zustand:1',
        rev: 2,
        cause: 'action',
        // zustand guesses the name from the stack, which Node 24 (like Hermes) does not give it.
        action: { type: expect.stringMatching(/\badd$|^anonymous$/) },
        ops: [{ op: 'set', path: ['count'], value: 1, prev: 0 }],
      },
      { store: 'zustand:1', rev: 3, cause: 'action', action: { type: 'counter/reset' }, ops: [{ op: 'set', path: ['count'], value: 0, prev: 1 }] },
    ]);
  });

  it('takes the state persist hydrates before init, as a change from nothing', () => {
    const { of } = harness();
    const store = createStore<Cart>()(
      devtools(
        persist((set) => ({ items: [], add: (item) => set((state) => ({ items: [...state.items, item] }), false, 'cart/add') }), {
          name: 'cart',
          storage: memoryStorage({ cart: { items: ['saved'] } }),
        }),
        { name: 'Cart' },
      ),
    );
    store.getState().add('fresh');
    vi.advanceTimersByTime(100);

    expect(of('state.store')).toEqual([{ store: { id: 'zustand:1', library: 'zustand', label: 'Cart', via: 'shim', actions: true } }]);
    const changes = of('state.change');
    expect(changes.map((change) => [change.cause, change.action?.type])).toEqual([
      ['action', expect.any(String)],
      ['init', undefined],
      ['action', 'cart/add'],
    ]);
    expect(changes[0].ops).toEqual([{ op: 'set', path: [], value: { items: ['saved'] }, prev: { $t: 'undefined' } }]);
    expect(changes[1].ops).toEqual([]);
    expect(changes[2].ops).toEqual([{ op: 'add', path: ['items', 1], value: 'fresh' }]);
  });

  it('keeps back what the app keeps from the extension through the devtools() options', () => {
    const { of } = harness();
    const store = createStore(
      devtools(() => ({ token: 'secret-token', count: 0 }), {
        name: 'Session',
        stateSanitizer: <S>(state: S) => ({ ...state, token: '[token]' }),
        actionsDenylist: 'tick',
      }),
    );
    store.setState({ count: 1 }, false, 'tick');
    store.setState({ count: 2 }, false, 'count');
    vi.advanceTimersByTime(100);

    expect(JSON.stringify(of('state.change'))).not.toContain('secret-token');
    expect(of('state.change')).toEqual([
      { store: 'zustand:1', rev: 1, cause: 'init', ops: [] },
      { store: 'zustand:1', rev: 2, cause: 'action', action: { type: 'count' }, ops: [{ op: 'set', path: ['count'], value: 2, prev: 0 }] },
    ]);
  });

  it('shows stores that share a connection through the store option as one, their states side by side', () => {
    const { of } = harness();
    const cart = createStore(devtools(() => ({ items: [] as string[] }), { name: 'Shop', store: 'cart' }));
    createStore(devtools(() => ({ name: 'Ann' }), { name: 'Shop', store: 'user' }));
    cart.setState({ items: ['milk'] }, false, 'add');
    vi.advanceTimersByTime(100);

    expect(of('state.store')).toEqual([{ store: { id: 'zustand:1', library: 'zustand', label: 'Shop', via: 'shim', actions: true } }]);
    expect(of('state.change')).toEqual([
      { store: 'zustand:1', rev: 1, cause: 'init', ops: [] },
      { store: 'zustand:1', rev: 2, cause: 'init', ops: [{ op: 'add', path: ['user'], value: { name: 'Ann' } }] },
      { store: 'zustand:1', rev: 3, cause: 'action', action: { type: 'cart/add' }, ops: [{ op: 'add', path: ['cart', 'items', 0], value: 'milk' }] },
    ]);
    expect(of('state.change').length).toBe(3);
  });

  it('keeps the three newest of a store that hot reload creates again under the same name', () => {
    const { of } = harness();
    for (let i = 0; i < 4; i++) createStore(devtools(() => ({ n: i }), { name: 'Reloaded' }));
    expect(of('state.store').map(({ store }) => [store.id, store.disposed ?? false])).toEqual([
      ['zustand:1', false],
      ['zustand:2', false],
      ['zustand:3', false],
      ['zustand:1', true],
      ['zustand:4', false],
    ]);
  });

  it('costs a stack trace per unnamed set only while the shim stands in, which redux: false avoids', () => {
    const make = (options: { anonymousActionType?: string } = {}) =>
      createStore<{ n: number; bump: () => void }>()(
        devtools((set) => ({ n: 0, bump: () => set((state) => ({ n: state.n + 1 })) }), { name: 'Busy', ...options }),
      );
    const shimmed = harness();
    const inferred = make();
    expect(stackTraces(() => inferred.getState().bump())).toBe(1);
    const typed = make({ anonymousActionType: 'bump' });
    expect(stackTraces(() => typed.getState().bump())).toBe(0);
    vi.advanceTimersByTime(100);
    expect(shimmed.of('state.change').at(-1)).toMatchObject({ store: 'zustand:2', action: { type: 'bump' } });
    shimmed.teardown();

    const { of } = harness({ redux: false });
    const quiet = make();
    expect(stackTraces(() => quiet.getState().bump())).toBe(0);
    expect(scope.__REDUX_DEVTOOLS_EXTENSION__).toBeUndefined();
    // The registry keeps the first two for the next client; `quiet` never connected.
    expect(of('state.store').map(({ store }) => store.id)).toEqual(['zustand:1', 'zustand:2']);
  });

  it('reads what a library sends through connect(): names, lifted states and errors, before init too', () => {
    const { of } = harness();
    const connection = scope.__REDUX_DEVTOOLS_EXTENSION__.connect({ name: 'Manual' });
    expect(connection.subscribe(() => {})).toBeTypeOf('function');
    connection.send('early', { n: 1 });
    connection.init({ n: 1 });
    connection.send({ payload: 2 }, { n: 2 });
    connection.send(null, { computedStates: [{ state: { n: 1 } }, { state: { n: 5 } }] });
    connection.error('boom');
    vi.advanceTimersByTime(100);

    expect(of('state.change')).toEqual([
      { store: 'zustand:1', rev: 1, cause: 'action', action: { type: 'early' }, ops: [{ op: 'set', path: [], value: { n: 1 }, prev: { $t: 'undefined' } }] },
      { store: 'zustand:1', rev: 2, cause: 'init', ops: [] },
      { store: 'zustand:1', rev: 3, cause: 'action', action: { type: 'update', payload: { payload: 2 } }, ops: [{ op: 'set', path: ['n'], value: 2, prev: 1 }] },
      { store: 'zustand:1', rev: 4, cause: 'external', ops: [{ op: 'set', path: ['n'], value: 5, prev: 2 }] },
      { store: 'zustand:1', rev: 5, cause: 'action', action: { type: '@@capybara/error', payload: { message: 'boom' } }, ops: [] },
    ]);
  });
});

describe('watchZustand', () => {
  it('watches a store without devtools() through subscribe: diffs, without action names', () => {
    const { of } = harness();
    const store = createStore<Counter>()((set) => ({
      count: 0,
      add: () => set((state) => ({ count: state.count + 1 })),
      reset: () => set({ count: 0 }),
    }));
    watchZustand(store, { name: 'Plain' });
    store.getState().add();
    vi.advanceTimersByTime(100);

    expect(of('state.store')).toEqual([{ store: { id: 'zustand:1', library: 'zustand', label: 'Plain', via: 'subscribe', actions: false } }]);
    expect(of('state.change')).toEqual([{ store: 'zustand:1', rev: 1, cause: 'set', ops: [{ op: 'set', path: ['count'], value: 1, prev: 0 }] }]);
  });

  it('skips a devtools() store the shim shows already unless forced, and watches a store once', () => {
    const before = createStore(devtools(() => ({ n: 0 }), { name: 'Before' }));
    const { of } = harness();
    const after = createStore(devtools(() => ({ n: 0 }), { name: 'After' }));
    // devtools() found no extension when `before` was created, so only watching shows it.
    watchZustand(before);
    watchZustand(after);
    const undo = watchZustand(after, { force: true, name: 'Forced' });
    watchZustand(after, { force: true })();
    expect(of('state.store').map(({ store }) => [store.label, store.via])).toEqual([
      ['After', 'shim'],
      [expect.stringMatching(/^zustand #\d+$/), 'subscribe'],
      ['Forced', 'subscribe'],
    ]);
    undo();
    expect(of('state.store').at(-1)).toEqual({
      store: { id: 'zustand:3', library: 'zustand', label: 'Forced', via: 'subscribe', actions: false, disposed: true },
    });
  });

  it('names a store after its persist name, else by a number a store of the same shape keeps', () => {
    const { of } = harness();
    watchZustand(createStore(persist(() => ({ token: '' }), { name: 'auth', storage: memoryStorage() })));
    watchZustand(createStore(() => ({ a: 1 })));
    // as a hot reload creates it again
    watchZustand(createStore(() => ({ a: 2 })));
    watchZustand(createStore(() => ({ b: 1 })));
    const labels = of('state.store').map(({ store }) => store.label);
    expect(labels[0]).toBe('auth');
    expect(labels[1]).toMatch(/^zustand #\d+$/);
    expect(labels[2]).toBe(labels[1]);
    expect(labels[3]).toMatch(/^zustand #\d+$/);
    expect(labels[3]).not.toBe(labels[1]);
  });

  it('leaves Redux stores alone, and does nothing without a window', () => {
    const { of } = harness();
    const reduxLike = { getState: () => 0, setState: () => {}, subscribe: () => () => {}, replaceReducer: () => {} };
    watchZustand(reduxLike);
    vi.unstubAllGlobals();
    watchZustand(createStore(() => ({ n: 0 })))();
    expect(of('state.store')).toEqual([]);
  });
});
