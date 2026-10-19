import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMiddleware, legacy_createStore, type Reducer } from 'redux';
import { CLIENT_GLOBAL, serialize, statePlugin, type PluginContext, type StatePluginOptions } from '../src/index.js';
import { capybaraReduxEnhancer, connectReduxStore } from '../src/plugins/state/redux.js';
import { REGISTRY_GLOBAL } from '../src/plugins/state/registry.js';

type Toolkit = typeof import('@reduxjs/toolkit');
type Recorded = { kind: string; payload: any };

const scope = globalThis as Record<string, any>;
const teardowns: Array<() => void> = [];

function harness(options: StatePluginOptions = {}) {
  const events: Recorded[] = [];
  const ctx: PluginContext = { emit: (kind, payload) => events.push({ kind, payload }), serialize, console };
  const plugin = statePlugin(options);
  const teardown = plugin.setup!(ctx) as () => void;
  teardowns.push(teardown);
  const of = (kind: string) => events.filter((e) => e.kind === kind).map((e) => e.payload);
  return { of, teardown, commands: plugin.commands! };
}

let loads = 0;
/**
 * Redux Toolkit reads the extension's globals once, while its module evaluates. Node caches node_modules itself
 * and vi.resetModules() does not reach that cache, so each load gets a URL of its own to evaluate again.
 */
async function loadToolkit(): Promise<Toolkit> {
  return import(/* @vite-ignore */ `${import.meta.resolve('@reduxjs/toolkit')}?load=${++loads}`);
}

function counter(toolkit: Toolkit) {
  const load = toolkit.createAsyncThunk('users/load', async (id: number) => ({ id, name: 'Ann' }));
  const slice = toolkit.createSlice({
    name: 'counter',
    initialState: { value: 0, status: 'idle', user: null as { id: number; name: string } | null },
    reducers: {
      increment: (state) => {
        state.value++;
      },
    },
    extraReducers: (builder) => {
      builder.addCase(load.pending, (state) => {
        state.status = 'loading';
      });
      builder.addCase(load.fulfilled, (state, action) => {
        state.status = 'idle';
        state.user = action.payload;
      });
    },
  });
  return { slice, load };
}

const count: Reducer<{ n: number }> = (state = { n: 0 }, action) => (action.type === 'inc' ? { n: state.n + 1 } : state);

/** Like the Redux DevTools extension, whose enhancer lifts actions and states as @redux-devtools/instrument does. */
function fakeExtension() {
  const seen: string[] = [];
  const connects: Array<Record<string, unknown>> = [];
  const reports: unknown[][] = [];
  let lifted: any;
  const ext = Object.assign(
    (_config?: unknown) => (next: any) => (reducer: any, preloaded: any) => {
      lifted = next(
        (state: any, action: any) => {
          if (action.type === 'PERFORM_ACTION') {
            seen.push(action.action.type);
            return { state: reducer(state.state, action.action) };
          }
          if (action.type === 'JUMP_TO_STATE') return { state: action.state };
          return { state: reducer(state?.state, action) };
        },
        { state: preloaded },
      );
      return {
        ...lifted,
        liftedStore: lifted,
        getState: () => lifted.getState().state,
        dispatch: (action: any) => {
          lifted.dispatch({ type: 'PERFORM_ACTION', action });
          return action;
        },
      };
    },
    {
      connect(options: Record<string, unknown>) {
        Object.assign(options, { name: 'Page title', instanceId: 1 });
        connects.push(options);
        return {
          init: (...args: unknown[]) => reports.push(['init', ...args]),
          send: (...args: unknown[]) => reports.push(['send', ...args]),
          subscribe: () => () => reports.push(['unsubscribe']),
          error: (message: unknown) => reports.push(['error', message]),
        };
      },
    },
  );
  // The extension's compose: its own enhancer innermost, the app's applied over it from right to left.
  const compose = (...args: any[]) => {
    const withConfig = (config: unknown) => (...funcs: any[]) => (createStore: any) =>
      funcs.reduceRight((composed: any, fn: any) => fn(composed), ext(config)(createStore));
    if (args.length === 0) return ext();
    if (args.length === 1 && typeof args[0] === 'object') return withConfig(args[0]);
    return withConfig({})(...args);
  };
  const jump = (state: unknown) => lifted.dispatch({ type: 'JUMP_TO_STATE', state });
  return { ext, compose, seen, connects, reports, jump };
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
  delete scope.__REDUX_DEVTOOLS_EXTENSION__;
  delete scope.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete scope[REGISTRY_GLOBAL];
});

describe('Redux DevTools shim', () => {
  it('shows a default configureStore() store with its actions, those of thunks included, and their diffs', async () => {
    const { of } = harness();
    const toolkit = await loadToolkit();
    const { slice, load } = counter(toolkit);
    const store = toolkit.configureStore({ reducer: { counter: slice.reducer } });
    store.dispatch(slice.actions.increment());
    await store.dispatch(load(7));
    vi.advanceTimersByTime(100);

    expect(of('state.store')).toEqual([
      { store: { id: 'redux:1', library: 'redux', label: expect.stringMatching(/^Redux store #\d+$/), via: 'shim', actions: true } },
    ]);
    const changes = of('state.change');
    expect(changes.map((change) => [change.rev, change.cause, change.action?.type])).toEqual([
      [1, 'init', undefined],
      [2, 'action', 'counter/increment'],
      [3, 'action', 'users/load/pending'],
      [4, 'action', 'users/load/fulfilled'],
    ]);
    expect(changes[0].ops).toEqual([]);
    expect(changes[1].ops).toEqual([{ op: 'set', path: ['counter', 'value'], value: 1, prev: 0 }]);
    expect(changes[2].ops).toEqual([{ op: 'set', path: ['counter', 'status'], value: 'loading', prev: 'idle' }]);
    expect(changes[3].ops).toEqual([
      { op: 'set', path: ['counter', 'status'], value: 'idle', prev: 'loading' },
      { op: 'set', path: ['counter', 'user'], value: { id: 7, name: 'Ann' }, prev: null },
    ]);
    expect(changes[3].action.payload).toMatchObject({ payload: { id: 7, name: 'Ann' }, meta: { arg: 7, requestStatus: 'fulfilled' } });
  });

  it('ignores the trace option Redux Toolkit turns on in development', async () => {
    const { of } = harness();
    const toolkit = await loadToolkit();
    const { slice } = counter(toolkit);
    const store = toolkit.configureStore({ reducer: { counter: slice.reducer }, devTools: { trace: true } });
    expect(stackTraces(() => store.dispatch(slice.actions.increment()))).toBe(0);
    vi.advanceTimersByTime(100);
    expect(of('state.change').at(-1)).toEqual({
      store: 'redux:1',
      rev: 2,
      cause: 'action',
      action: { type: 'counter/increment', payload: { payload: { $t: 'undefined' } } },
      ops: [{ op: 'set', path: ['counter', 'value'], value: 1, prev: 0 }],
    });
  });

  it('keeps back what the app keeps from the extension: sanitized state and actions, denylisted actions', async () => {
    const { of, commands } = harness();
    const toolkit = await loadToolkit();
    const auth = toolkit.createSlice({
      name: 'auth',
      initialState: { token: '', user: '', ticks: 0 },
      reducers: {
        login: (state, action: { payload: { token: string; user: string } }) => ({ ...state, ...action.payload }),
        tick: (state) => {
          state.ticks++;
        },
        rename: (state, action: { payload: string }) => {
          state.user = action.payload;
        },
      },
    });
    const store = toolkit.configureStore({
      reducer: { auth: auth.reducer },
      devTools: {
        stateSanitizer: <S>(state: S) => ({ ...state, auth: { ...(state as any).auth, token: '[token]' } }),
        actionSanitizer: <A>(action: A) => ((action as any).type === 'auth/login' ? { ...action, payload: '[login]' } : action),
        actionsDenylist: ['auth/tick'],
      },
    });
    store.dispatch(auth.actions.login({ token: 'secret-token', user: 'ann' }));
    store.dispatch(auth.actions.tick());
    store.dispatch(auth.actions.rename('bob'));
    vi.advanceTimersByTime(100);

    const changes = of('state.change');
    expect(JSON.stringify(changes)).not.toContain('secret-token');
    expect(changes.map((change) => change.action?.type ?? change.cause)).toEqual(['init', 'auth/login', 'auth/rename']);
    expect(changes[1].action).toEqual({ type: 'auth/login', payload: { payload: '[login]' } });
    // The denylisted tick shows with the next change.
    expect(changes[2].ops).toEqual([
      { op: 'set', path: ['auth', 'user'], value: 'bob', prev: 'ann' },
      { op: 'set', path: ['auth', 'ticks'], value: 1, prev: 0 },
    ]);
    expect(commands.get!({ store: 'redux:1', path: ['auth'] })).toEqual({
      rev: 3,
      pending: false,
      value: { token: '[token]', user: 'bob', ticks: 1 },
      truncated: false,
    });
  });

  it('shows a legacy createStore() store, and a replaced reducer as an external change', () => {
    const { of } = harness();
    const store = legacy_createStore(count, scope.__REDUX_DEVTOOLS_EXTENSION__({ name: 'Legacy' }));
    store.dispatch({ type: 'inc' });
    store.replaceReducer(((state = { n: 0 }) => ({ ...state, hot: true })) as Reducer<{ n: number }>);
    vi.advanceTimersByTime(100);

    expect(of('state.store')).toEqual([{ store: { id: 'redux:1', library: 'redux', label: 'Legacy', via: 'shim', actions: true } }]);
    expect(of('state.change')).toEqual([
      { store: 'redux:1', rev: 1, cause: 'init', ops: [] },
      { store: 'redux:1', rev: 2, cause: 'action', action: { type: 'inc' }, ops: [{ op: 'set', path: ['n'], value: 1, prev: 0 }] },
      { store: 'redux:1', rev: 3, cause: 'external', action: { type: '@@redux/REPLACE' }, ops: [{ op: 'add', path: ['hot'], value: true }] },
    ]);
  });

  it('records each change under its own action when a listener dispatches again', () => {
    const { of } = harness();
    const store = legacy_createStore(count, scope.__REDUX_DEVTOOLS_EXTENSION__());
    store.subscribe(() => {
      if (store.getState().n === 1) store.dispatch({ type: 'inc', echo: true });
    });
    store.dispatch({ type: 'inc' });
    vi.advanceTimersByTime(100);
    expect(of('state.change').slice(1)).toEqual([
      { store: 'redux:1', rev: 2, cause: 'action', action: { type: 'inc' }, ops: [{ op: 'set', path: ['n'], value: 1, prev: 0 }] },
      {
        store: 'redux:1',
        rev: 3,
        cause: 'action',
        action: { type: 'inc', payload: { echo: true } },
        ops: [{ op: 'set', path: ['n'], value: 2, prev: 1 }],
      },
    ]);
  });

  it('answers each way compose is called, and the extension’s own send', () => {
    const { of } = harness();
    const compose = scope.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__;
    const only = (key: string): Reducer => (state = { [key]: 0 }) => state;
    legacy_createStore(only('a'), compose());
    legacy_createStore(only('b'), compose({ name: 'Configured' })(applyMiddleware()));
    legacy_createStore(only('c'), compose(applyMiddleware()));
    scope.__REDUX_DEVTOOLS_EXTENSION__.send({ type: 'logged' }, { x: 1 }, { name: 'Sent' });
    vi.advanceTimersByTime(100);

    const numbered = expect.stringMatching(/^Redux store #\d+$/);
    expect(of('state.store').map(({ store }) => [store.label, store.via])).toEqual([
      [numbered, 'shim'],
      ['Configured', 'shim'],
      [numbered, 'shim'],
      ['Sent', 'shim'],
    ]);
    expect(of('state.change').at(-1)).toEqual({
      store: 'redux:4',
      rev: 1,
      cause: 'action',
      action: { type: 'logged' },
      ops: [{ op: 'set', path: [], value: { x: 1 }, prev: { $t: 'undefined' } }],
    });
  });

  it('names a store by its option, then devTools.name, then a number a store created again keeps', async () => {
    const { of } = harness();
    const toolkit = await loadToolkit();
    const todos = { reducer: { todos: (state: string[] = []) => state } };
    toolkit.configureStore({ ...todos, devTools: { name: 'Todos' } });
    toolkit.configureStore({ ...todos, devTools: { name: 'Ignored' }, enhancers: (getDefault) => getDefault().concat(capybaraReduxEnhancer({ name: 'Mine' })) });
    toolkit.configureStore(todos);
    // as a hot reload creates it again
    toolkit.configureStore(todos);
    toolkit.configureStore({ reducer: { users: (state: string[] = []) => state } });

    const labels = of('state.store').map(({ store }) => store.label);
    expect(labels.slice(0, 2)).toEqual(['Todos', 'Mine']);
    expect(labels[2]).toMatch(/^Redux store #\d+$/);
    expect(labels[3]).toBe(labels[2]);
    expect(labels[4]).toMatch(/^Redux store #\d+$/);
    expect(labels[4]).not.toBe(labels[2]);
  });
});

describe('Redux DevTools shim over the real extension', () => {
  it('puts Capybara right above the extension’s enhancer, so both see every action', async () => {
    const extension = fakeExtension();
    scope.__REDUX_DEVTOOLS_EXTENSION__ = extension.ext;
    scope.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__ = extension.compose;
    const { of } = harness();
    const toolkit = await loadToolkit();
    const { slice, load } = counter(toolkit);
    const store = toolkit.configureStore({ reducer: { counter: slice.reducer } });
    store.dispatch(slice.actions.increment());
    await store.dispatch(load(1));
    extension.jump({ counter: { value: 5, status: 'idle', user: null } });
    vi.advanceTimersByTime(100);

    expect(extension.seen).toEqual(['counter/increment', 'users/load/pending', 'users/load/fulfilled']);
    // Unlifted: under the extension's enhancer, paths would start with its `state` and actions be PERFORM_ACTION.
    const changes = of('state.change');
    expect(changes.map((change) => [change.cause, change.action?.type])).toEqual([
      ['init', undefined],
      ['action', 'counter/increment'],
      ['action', 'users/load/pending'],
      ['action', 'users/load/fulfilled'],
      ['external', undefined],
    ]);
    expect(changes[1].ops).toEqual([{ op: 'set', path: ['counter', 'value'], value: 1, prev: 0 }]);
    expect(changes[4].ops).toEqual([
      { op: 'set', path: ['counter', 'value'], value: 5, prev: 1 },
      { op: 'set', path: ['counter', 'user'], value: null, prev: { id: 1, name: 'Ann' } },
    ]);
    expect(store.getState().counter.value).toBe(5);
  });

  it('tees connect(), giving the extension a copy of the options to write into', () => {
    const extension = fakeExtension();
    scope.__REDUX_DEVTOOLS_EXTENSION__ = extension.ext;
    const { of } = harness();
    const options = { name: 'Cart' };
    const connection = scope.__REDUX_DEVTOOLS_EXTENSION__.connect(options);
    connection.init({ items: [] });
    connection.send({ type: 'cart/add' }, { items: ['milk'] });
    const unsubscribe = connection.subscribe(() => {});
    unsubscribe();
    const unnamed = scope.__REDUX_DEVTOOLS_EXTENSION__.connect({});
    unnamed.init({ other: true });
    vi.advanceTimersByTime(100);

    expect(options).toEqual({ name: 'Cart' });
    expect(extension.connects).toEqual([
      { name: 'Page title', instanceId: 1 },
      { name: 'Page title', instanceId: 1 },
    ]);
    expect(extension.reports).toEqual([
      ['init', { items: [] }],
      ['send', { type: 'cart/add' }, { items: ['milk'] }],
      ['unsubscribe'],
      ['init', { other: true }],
    ]);
    expect(of('state.store').map(({ store }) => store.label)).toEqual(['Cart', expect.stringMatching(/^zustand #\d+$/)]);
    expect(of('state.change').filter((change) => change.store === 'zustand:1')).toEqual([
      { store: 'zustand:1', rev: 1, cause: 'init', ops: [] },
      { store: 'zustand:1', rev: 2, cause: 'action', action: { type: 'cart/add' }, ops: [{ op: 'add', path: ['items', 0], value: 'milk' }] },
    ]);
  });

  it('wraps the extension once, and on teardown puts back only the globals still its own', () => {
    const extension = fakeExtension();
    scope.__REDUX_DEVTOOLS_EXTENSION__ = extension.ext;
    scope.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__ = extension.compose;
    const first = harness();
    const shim = scope.__REDUX_DEVTOOLS_EXTENSION__;
    expect(shim).not.toBe(extension.ext);
    // init() again, or hot reload running the entry file again
    harness().teardown();
    expect(scope.__REDUX_DEVTOOLS_EXTENSION__).toBe(shim);

    const theirs = () => (next: unknown) => next;
    scope.__REDUX_DEVTOOLS_EXTENSION__ = theirs;
    first.teardown();
    expect(scope.__REDUX_DEVTOOLS_EXTENSION__).toBe(theirs);
    expect(scope.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__).toBe(extension.compose);
  });

  it('leaves no global behind where there was none, and installs none with redux: false', () => {
    harness({ redux: false });
    expect('__REDUX_DEVTOOLS_EXTENSION__' in scope).toBe(false);
    const { teardown } = harness();
    expect(typeof scope.__REDUX_DEVTOOLS_EXTENSION__).toBe('function');
    expect(typeof scope.__REDUX_DEVTOOLS_EXTENSION_COMPOSE__).toBe('function');
    teardown();
    expect('__REDUX_DEVTOOLS_EXTENSION__' in scope).toBe(false);
    expect('__REDUX_DEVTOOLS_EXTENSION_COMPOSE__' in scope).toBe(false);
  });
});

describe('capybaraReduxEnhancer and connectReduxStore', () => {
  it('cannot see the stores of a Redux Toolkit loaded before the shim, where the enhancer can', async () => {
    const early = await loadToolkit();
    const { of } = harness();
    const { slice, load } = counter(early);
    early.configureStore({ reducer: { counter: slice.reducer } });
    expect(of('state.store')).toEqual([]);

    const store = early.configureStore({
      reducer: { counter: slice.reducer },
      enhancers: (getDefault) => getDefault().concat(capybaraReduxEnhancer({ name: 'Early' })),
    });
    await store.dispatch(load(1));
    vi.advanceTimersByTime(100);
    expect(of('state.store')).toEqual([{ store: { id: 'redux:1', library: 'redux', label: 'Early', via: 'enhancer', actions: true } }]);
    expect(of('state.change').map((change) => change.action?.type ?? change.cause)).toEqual(['init', 'users/load/pending', 'users/load/fulfilled']);
  });

  it('shows a store the shim and the enhancer both see once, under the enhancer’s name', async () => {
    const { of } = harness();
    const toolkit = await loadToolkit();
    const { slice } = counter(toolkit);
    const store = toolkit.configureStore({
      reducer: { counter: slice.reducer },
      enhancers: (getDefault) => getDefault().prepend(capybaraReduxEnhancer({ name: 'Once' })),
    });
    const undo = connectReduxStore(store, { name: 'Twice' });
    store.dispatch(slice.actions.increment());
    vi.advanceTimersByTime(100);
    undo();

    expect(of('state.store')).toEqual([{ store: { id: 'redux:1', library: 'redux', label: 'Once', via: 'shim', actions: true } }]);
    expect(of('state.change').map((change) => change.action?.type ?? change.cause)).toEqual(['init', 'counter/increment']);
  });

  it('connects a store made earlier: its own actions by name, those of thunks as unknown, until undone', async () => {
    const toolkit = await loadToolkit();
    const { slice, load } = counter(toolkit);
    const store = toolkit.configureStore({ reducer: { counter: slice.reducer } });
    const dispatch = store.dispatch;
    const { of } = harness();
    const undo = connectReduxStore(store, { name: 'Late' });
    store.dispatch(slice.actions.increment());
    await store.dispatch(load(2));
    vi.advanceTimersByTime(100);

    expect(of('state.store')).toEqual([{ store: { id: 'redux:1', library: 'redux', label: 'Late', via: 'connect', actions: true } }]);
    expect(of('state.change').map((change) => change.action?.type)).toEqual(['counter/increment', 'unknown action', 'unknown action']);
    undo();
    expect(store.dispatch).toBe(dispatch);
    expect(of('state.store').at(-1)).toEqual({
      store: { id: 'redux:1', library: 'redux', label: 'Late', via: 'connect', actions: true, disposed: true },
    });
    store.dispatch(slice.actions.increment());
    vi.advanceTimersByTime(100);
    expect(of('state.change')).toHaveLength(3);
  });

  it('does nothing without a window, as in server rendering', () => {
    vi.unstubAllGlobals();
    const { of } = harness();
    expect('__REDUX_DEVTOOLS_EXTENSION__' in scope).toBe(false);
    const store = legacy_createStore(count, capybaraReduxEnhancer({ name: 'Server' }));
    const undo = connectReduxStore(store);
    store.dispatch({ type: 'inc' });
    undo();
    expect(store.getState()).toEqual({ n: 1 });
    expect(of('state.store')).toEqual([]);
  });
});
