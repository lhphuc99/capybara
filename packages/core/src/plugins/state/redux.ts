import type { StateChangePayload, StateStoreInfo } from '@capybara-devtools/protocol';
import type { StateSink, StoreDriver } from './index.js';
import { register, unregister } from './registry.js';

/** What Capybara reads of a Redux store. Redux 4 and 5 stores and Redux Toolkit's fit. */
export interface ReduxStoreLike {
  getState(): unknown;
  dispatch(action: any, ...rest: any[]): any;
  subscribe(listener: () => void): () => void;
  replaceReducer?(nextReducer: any): void;
}

export interface ReduxStoreOptions {
  /** Shown in the State tab. Defaults to Redux Toolkit's `devTools.name`, then "Redux store #n". */
  name?: string;
}

/** A Redux store enhancer, typed loosely so the SDK needs no Redux types. */
export type ReduxStoreEnhancer = <StoreCreator>(next: StoreCreator) => StoreCreator;

type AnyFunction = (...args: any[]) => any;
type Via = StateStoreInfo['via'];

/** What `connect()` returns. zustand's devtools() and other libraries report their state through it. */
interface Connection {
  init(state: unknown, liftedData?: unknown): unknown;
  send(action: unknown, state: unknown): unknown;
  subscribe(listener: unknown): () => void;
  unsubscribe(): unknown;
  error(message: unknown): unknown;
}

/** The Redux DevTools extension's global, as far as the shim passes calls on to it. */
interface Extension {
  (config?: unknown): (next: AnyFunction) => AnyFunction;
  connect?(options: object): Partial<Connection> | null | undefined;
  send?(action: unknown, state: unknown, options?: unknown, instanceId?: unknown): unknown;
  open?(...args: unknown[]): unknown;
  notifyErrors?(...args: unknown[]): unknown;
  listen?(...args: unknown[]): unknown;
  disconnect?(...args: unknown[]): unknown;
}

/** The sanitizers and filters an app gave the extension, applied the same way before anything leaves the app. */
interface Filters {
  state(raw: unknown): unknown;
  action(action: unknown): unknown;
  /** A change to keep off the timeline; it shows with the next one. */
  hidden(action: unknown, state: unknown): boolean;
}

interface Watch {
  driver: StoreDriver;
  /** The store's `getState`, which stands for the store in the registry and in `watched`. */
  key: object;
  id: string | undefined;
  sink: StateSink | null;
  /** Actions being dispatched, innermost last. A change while it is empty did not come through dispatch. */
  stack: unknown[];
  filters: Filters | undefined;
}

const EXTENSION = '__REDUX_DEVTOOLS_EXTENSION__';
const COMPOSE = '__REDUX_DEVTOOLS_EXTENSION_COMPOSE__';
/** Marks the shim's globals. From `Symbol.for`, so a second copy of the SDK sees the first one's shim. */
const SHIM = Symbol.for('capybara.reduxShim');
/** Holds the name given to an enhancer from capybaraReduxEnhancer(). */
const EXPLICIT = Symbol.for('capybara.reduxEnhancer');
/** Stores made from the extension's own `send`, one per name. */
const MAX_SENT = 20;
/** On the stack while `replaceReducer` runs: its `@@redux/REPLACE` goes around the wrapped dispatch. */
const REPLACING = {};
const LABELS = { redux: 'Redux store', zustand: 'zustand', xstate: 'XState actor', mobx: 'MobX store' } as const;

/**
 * Stores being watched, by `getState`. Redux Toolkit and the enhancers further out pass that function on as it
 * is, so it is the same key from inside the enhancer chain and for the store the app holds.
 */
const watched = new WeakMap<object, Watch>();
const labelNumbers = new Map<string, number>();
const labelCounts = new Map<string, number>();

/**
 * Stands in for the Redux DevTools extension, or wraps it when installed, so stores created from now on show
 * in the State tab: Redux Toolkit's configureStore(), `createStore(reducer, window.__REDUX_DEVTOOLS_EXTENSION__())`
 * and zustand's devtools(). Returns the undo, which puts back each global only while it is still the shim's.
 */
export function installReduxShim(): () => void {
  if (typeof window === 'undefined') return () => {};
  const scope = window as unknown as Record<string, unknown>;
  try {
    const real = scope[EXTENSION];
    const realCompose = scope[COMPOSE];
    // Installed already: hot reload, init() again, or a second copy of the SDK.
    if (isShim(real) || isShim(realCompose)) return () => {};
    const shim = createShim(
      typeof real === 'function' ? (real as Extension) : undefined,
      typeof realCompose === 'function' ? (realCompose as AnyFunction) : undefined,
    );
    const undo: Array<() => void> = [];
    const restore = () => {
      for (const step of undo) step();
    };
    try {
      undo.push(put(scope, EXTENSION, shim.extension));
      undo.push(put(scope, COMPOSE, shim.compose));
    } catch {
      restore();
      return () => {};
    }
    return restore;
  } catch {
    return () => {};
  }
}

/** Whether the shim is the extension now, so devtools() stores created meanwhile report through it. */
export function reduxShimActive(): boolean {
  try {
    return typeof window !== 'undefined' && isShim((window as unknown as Record<string, unknown>)[EXTENSION]);
  } catch {
    return false;
  }
}

/**
 * A store enhancer that shows the store in the State tab, for stores the shim cannot see: created before
 * `init()`, by a Redux Toolkit that loaded before it, or with `devTools: false`. A store the shim sees too is
 * shown once, under this enhancer's name when both are in Redux Toolkit's `enhancers`.
 */
export function capybaraReduxEnhancer(options: ReduxStoreOptions = {}): ReduxStoreEnhancer {
  const name = nameOf(options);
  const enhancer = watching(name, 'enhancer');
  Object.defineProperty(enhancer, EXPLICIT, { value: { name } });
  return enhancer as unknown as ReduxStoreEnhancer;
}

/**
 * Shows a store that exists already. Best effort: the actions middleware dispatches, e.g. from thunks, show as
 * "unknown action"; capybaraReduxEnhancer() names them. Returns a function that undoes this call.
 */
export function connectReduxStore(store: ReduxStoreLike, options: ReduxStoreOptions = {}): () => void {
  if (typeof window === 'undefined' || !isStore(store)) return () => {};
  try {
    const known = watched.get(store.getState);
    if (known) {
      // The registry may have dropped it since, e.g. for a newer instance under the same label.
      enroll(known);
      return () => {};
    }
    const watch = createWatch(store, nameOf(options) ?? defaultLabel('redux', store.getState()), 'connect');
    const unsubscribe = store.subscribe(onChange(watch, store));
    const undo = [
      patch(store, 'dispatch', (original) => dispatching(watch, store, original)),
      patch(store, 'replaceReducer', (original) => dispatching(watch, store, original, REPLACING)),
    ];
    watched.set(watch.key, watch);
    enroll(watch);
    let undone = false;
    return () => {
      if (undone) return;
      undone = true;
      watched.delete(watch.key);
      try {
        if (watch.id !== undefined) unregister(watch.id);
        unsubscribe();
        for (const step of undo) step();
      } catch {
        // the store may be torn down already
      }
    };
  } catch {
    return () => {};
  }
}

/**
 * "Redux store #2". Numbered by the keys of the state rather than in creation order, so a store that a hot
 * reload creates again keeps its label, which is how the UI recognizes it.
 */
export function defaultLabel(library: keyof typeof LABELS, state: unknown): string {
  const prefix = LABELS[library];
  let shape: string = typeof state;
  try {
    if (Array.isArray(state)) shape = 'array';
    else if (state !== null && typeof state === 'object') {
      const keys = Object.keys(state);
      shape = keys.length > 50 ? 'object' : `{${keys.sort().join(',')}}`;
    }
  } catch {
    // a proxy that will not list its keys
  }
  const key = `${prefix}\n${shape}`;
  let n = labelNumbers.get(key);
  if (n === undefined) {
    n = (labelCounts.get(prefix) ?? 0) + 1;
    labelCounts.set(prefix, n);
    if (labelNumbers.size < 1_000) labelNumbers.set(key, n);
  }
  return `${prefix} #${n}`;
}

function createShim(real: Extension | undefined, realCompose: AnyFunction | undefined) {
  const sent = new Map<string, Connection>();
  // Right above the extension's own enhancer, whose store keeps lifted actions and states.
  const enhancerFor = (config: unknown, name: string | undefined) => {
    const theirs = real?.(config);
    const ours = watching(name, 'shim', config);
    return (next: AnyFunction) => ours(theirs ? theirs(next) : next);
  };
  // Redux Toolkit passes `trace: true` in development; the shim never builds those stacks.
  const extension: Extension = Object.assign((config?: unknown) => enhancerFor(config, nameOf(config)), {
    connect(options: object) {
      // The extension writes an instanceId and a default name into the options it is given.
      const theirs = real?.connect?.(copy(options));
      const ours = connection(copy(options), 'zustand');
      return theirs !== null && typeof theirs === 'object' ? tee(theirs, ours) : ours;
    },
    send(action: unknown, state: unknown, options?: unknown, instanceId?: unknown) {
      try {
        const name = nameOf(options);
        const key = name ?? (instanceId === undefined || instanceId === null ? '' : `#${String(instanceId)}`);
        let target = sent.get(key);
        if (!target) {
          if (sent.size >= MAX_SENT) sent.delete(sent.keys().next().value!);
          target = connection(copy(options), 'redux');
          sent.set(key, target);
        }
        target.send(action, state);
      } catch {
        // never throw into the app
      }
      return real?.send?.(action, state, options, instanceId);
    },
    open: (...args: unknown[]) => real?.open?.(...args),
    notifyErrors: (...args: unknown[]) => real?.notifyErrors?.(...args),
    listen: (...args: unknown[]) => real?.listen?.(...args),
    disconnect: (...args: unknown[]) => real?.disconnect?.(...args),
  });

  const withCapybara = (config: unknown, funcs: unknown[]): unknown => {
    let name = nameOf(config);
    // A capybaraReduxEnhancer() in the list would watch the same store from further out; the shim's takes its name.
    const rest = funcs.filter((fn) => {
      const explicit = typeof fn === 'function' ? (fn as unknown as Record<symbol, { name?: string }>)[EXPLICIT] : undefined;
      if (!explicit) return true;
      name = explicit.name ?? name;
      return false;
    });
    // Last in the list, so applied first: under applyMiddleware, it sees the actions thunks dispatch.
    if (realCompose) return (realCompose(config) as AnyFunction)(...rest, watching(name, 'shim', config));
    return [...rest, enhancerFor(config, name)].reduce(
      (outer, inner) =>
        (...args: unknown[]) =>
          (outer as AnyFunction)((inner as AnyFunction)(...args)),
    );
  };
  const compose = (...args: unknown[]): unknown => {
    if (args.length === 0) return extension();
    if (args.length === 1 && typeof args[0] === 'object') {
      const config = args[0];
      return (...funcs: unknown[]) => withCapybara(config, funcs);
    }
    return withCapybara({}, args);
  };

  for (const fn of [extension, compose]) Object.defineProperty(fn, SHIM, { value: true });
  return { extension, compose };
}

/**
 * Reports go to both, ours first: it never throws, so the extension's errors reach the app as before. Messages
 * such as time travel come only from the extension.
 */
function tee(theirs: Partial<Connection>, ours: Connection): Connection {
  return {
    init(...args: [unknown, unknown?]) {
      ours.init(args[0]);
      return theirs.init?.(...args);
    },
    send(action, state) {
      ours.send(action, state);
      return theirs.send?.(action, state);
    },
    subscribe(listener) {
      const off = theirs.subscribe?.(listener);
      return () => {
        if (typeof off === 'function') off();
      };
    },
    unsubscribe() {
      return theirs.unsubscribe?.();
    },
    error(message) {
      ours.error(message);
      return theirs.error?.(message);
    },
  };
}

/**
 * A store per `connect()`. The library sends its whole state with each action, so the driver keeps only the
 * last one. `send` may come before `init`, e.g. from persist hydrating synchronously.
 */
function connection(options: Record<string, unknown>, library: 'redux' | 'zustand'): Connection {
  const name = nameOf(options);
  const filters = filtersOf(options);
  let state: unknown;
  let id: string | undefined;
  let sink: StateSink | null = null;
  let registered = false;
  const driver: StoreDriver = {
    info: { library, label: name ?? '', via: 'shim', actions: true },
    getState: () => (filters ? filters.state(state) : state),
    start(next, storeId) {
      sink = next;
      id = storeId;
      return () => {
        if (sink === next) sink = null;
      };
    },
  };
  const report = (next: unknown, action: unknown, cause?: StateChangePayload['cause']) => {
    if (!registered) {
      registered = true;
      // `init` is the state to start from; a `send` before it changed a state never seen.
      if (cause === 'init') state = next;
      if (name === undefined) driver.info.label = defaultLabel(library, next);
      id = register(driver, self) ?? id;
    }
    state = next;
    if (sink === null || id === undefined || (action !== undefined && filters?.hidden(action, next))) return;
    sink.record(id, driver.getState!(), action !== undefined && filters ? filters.action(action) : action, cause);
  };
  // v1 never messages the app, so `subscribe` keeps no listener; zustand calls it without checking it exists.
  const self: Connection = {
    init(next) {
      try {
        report(next, undefined, 'init');
      } catch {
        // never throw into the app's store
      }
    },
    send(action, next) {
      try {
        if (!action) {
          // Without an action, `next` is the extension's lifted state: zustand sends one after an import.
          const computed = (next as { computedStates?: unknown } | null)?.computedStates;
          const last: unknown = Array.isArray(computed) ? computed[computed.length - 1] : undefined;
          if (last !== null && typeof last === 'object' && 'state' in last) report(last.state, undefined, 'external');
          return;
        }
        report(next, amendAction(action));
      } catch {
        // never throw into the app's store
      }
    },
    subscribe: () => () => {},
    unsubscribe: () => {},
    error(message) {
      try {
        if (registered) report(state, { type: '@@capybara/error', message });
      } catch {
        // never throw into the app's store
      }
    },
  };
  return self;
}

/** As the extension reads an action: a string is its type, a missing type is "update", PERFORM_ACTION unwraps. */
function amendAction(action: unknown): unknown {
  if (typeof action === 'string') return { type: action };
  if (action === null || typeof action !== 'object') return { type: 'update' };
  const { type, action: inner } = action as { type?: unknown; action?: unknown };
  if (!type) return { ...action, type: 'update' };
  if (type === 'PERFORM_ACTION' && inner !== null && typeof inner === 'object') return inner;
  return action;
}

/** `config` holds the extension's options, whose sanitizers and filters apply to each store the enhancer makes. */
function watching(name: string | undefined, via: Via, config?: unknown) {
  return (next: AnyFunction) =>
    (...args: unknown[]) =>
      watchCreated(next(...args), name, via, config);
}

/** Watches a store as an enhancer creates it, and hands on a copy whose dispatch keeps the action stack. */
function watchCreated(store: unknown, name: string | undefined, via: Via, config?: unknown): unknown {
  if (typeof window === 'undefined' || !isStore(store)) return store;
  try {
    // An enhancer further in watches it already, from where it sees more.
    if (watched.has(store.getState)) return store;
    const watch = createWatch(store, name ?? defaultLabel('redux', store.getState()), via, filtersOf(config));
    // Subscribed before anything outside can be, so each change is recorded before another listener dispatches.
    store.subscribe(onChange(watch, store));
    const created: ReduxStoreLike = { ...store, dispatch: dispatching(watch, store, store.dispatch) };
    if (typeof store.replaceReducer === 'function') {
      created.replaceReducer = dispatching(watch, store, store.replaceReducer, REPLACING);
    }
    watched.set(watch.key, watch);
    const id = enroll(watch);
    if (id !== undefined && watch.sink !== null) watch.sink.record(id, watch.driver.getState!(), undefined, 'init');
    return created;
  } catch {
    return store;
  }
}

function createWatch(store: ReduxStoreLike, label: string, via: Via, filters?: Filters): Watch {
  const watch: Watch = {
    key: store.getState,
    id: undefined,
    sink: null,
    stack: [],
    filters,
    driver: {
      info: { library: 'redux', label, via, actions: true },
      getState: () => (filters ? filters.state(store.getState()) : store.getState()),
      start(sink, id) {
        watch.sink = sink;
        watch.id = id;
        return () => {
          if (watch.sink === sink) watch.sink = null;
        };
      },
    },
  };
  return watch;
}

/** Registers the store, or gets its id when it is registered already. */
function enroll(watch: Watch): string | undefined {
  const id = register(watch.driver, watch.key);
  if (id !== undefined) watch.id = id;
  return id;
}

function onChange(watch: Watch, store: ReduxStoreLike): () => void {
  return () => {
    const { sink, id, stack, filters } = watch;
    if (sink === null || id === undefined) return;
    try {
      let action = stack.length > 0 ? stack[stack.length - 1] : undefined;
      let cause: StateChangePayload['cause'] | undefined;
      if (action === REPLACING) {
        action = { type: '@@redux/REPLACE' };
        cause = 'external';
      } else if (action === undefined) {
        // connectReduxStore's patch is outside applyMiddleware, which dispatches to the store underneath.
        if (watch.driver.info.via === 'connect') action = { type: 'unknown action' };
        // e.g. the extension travelling in time
        else cause = 'external';
      }
      const state = store.getState();
      if (!filters) sink.record(id, state, action, cause);
      else if (action === undefined) sink.record(id, filters.state(state), undefined, cause);
      else if (!filters.hidden(action, state)) sink.record(id, filters.state(state), filters.action(action), cause);
    } catch {
      // never throw into the app's store
    }
  };
}

/**
 * The extension's options that keep data back: `stateSanitizer`, `actionSanitizer`, `actionsDenylist`,
 * `actionsAllowlist` and `predicate`, read as the extension reads them. Undefined when there are none.
 */
function filtersOf(options: unknown): Filters | undefined {
  const o = copy(options);
  const stateSanitizer = typeof o.stateSanitizer === 'function' ? (o.stateSanitizer as AnyFunction) : undefined;
  const actionSanitizer = typeof o.actionSanitizer === 'function' ? (o.actionSanitizer as AnyFunction) : undefined;
  const predicate = typeof o.predicate === 'function' ? (o.predicate as AnyFunction) : undefined;
  const deny = pattern(o.actionsDenylist ?? o.actionsBlacklist);
  const allow = pattern(o.actionsAllowlist ?? o.actionsWhitelist);
  if (!stateSanitizer && !actionSanitizer && !predicate && !deny && !allow) return undefined;
  let count = 0;
  let raw: unknown = {};
  let clean: unknown;
  return {
    // Kept by reference, so a store that has not changed reads as the same state rather than a pending one.
    state(next) {
      if (!stateSanitizer) return next;
      if (next !== raw) {
        raw = next;
        try {
          clean = stateSanitizer(next, count);
        } catch (error) {
          // Never fall back to the state the sanitizer was meant to filter.
          clean = `[stateSanitizer threw: ${error instanceof Error ? error.message : String(error)}]`;
        }
      }
      return clean;
    },
    action(action) {
      if (!actionSanitizer) return action;
      try {
        return actionSanitizer(action, count++);
      } catch {
        return { type: typeOf(action) };
      }
    },
    hidden(action, state) {
      const type = typeOf(action);
      try {
        return (allow !== undefined && !allow.test(type)) || deny?.test(type) || (predicate !== undefined && !predicate(state, action));
      } catch {
        return false;
      }
    },
  };
}

/** A list of action types as the extension joins it: a string or strings, as one regular expression. */
function pattern(list: unknown): RegExp | undefined {
  try {
    if (typeof list === 'string' && list !== '') return new RegExp(list);
    if (Array.isArray(list) && list.length > 0) return new RegExp(list.join('|'));
  } catch {
    // an invalid pattern filters nothing
  }
  return undefined;
}

function typeOf(action: unknown): string {
  if (typeof action === 'string') return action;
  try {
    return String((action as { type?: unknown } | null)?.type ?? '');
  } catch {
    return '';
  }
}

/** `original`, with the action on the stack while it runs. While no client watches, it only reads one flag. */
function dispatching(watch: Watch, target: object, original: AnyFunction, marker?: object): AnyFunction {
  return function (this: unknown, action: unknown) {
    // Thunks and other non-actions stay off the stack: only the actions they dispatch change the state.
    if (watch.sink === null || (marker === undefined && (action === null || typeof action !== 'object'))) {
      return original.apply(target, arguments as unknown as unknown[]);
    }
    watch.stack.push(marker ?? action);
    try {
      return original.apply(target, arguments as unknown as unknown[]);
    } finally {
      watch.stack.pop();
    }
  };
}

/** Replaces a method of the app's store. The undo leaves alone a method someone replaced since. */
function patch(store: ReduxStoreLike, name: 'dispatch' | 'replaceReducer', make: (original: AnyFunction) => AnyFunction): () => void {
  const target = store as unknown as Record<string, unknown>;
  const original = target[name];
  if (typeof original !== 'function') return () => {};
  const wrapper = make(original as AnyFunction);
  try {
    target[name] = wrapper;
  } catch {
    // A frozen store keeps its method, and its changes show as unknown actions.
    return () => {};
  }
  return () => {
    if (target[name] === wrapper) target[name] = original;
  };
}

/** Sets a global; the undo puts back what was there, only while the global is still `value`. */
function put(scope: Record<string, unknown>, key: string, value: unknown): () => void {
  const had = Object.prototype.hasOwnProperty.call(scope, key);
  const previous = scope[key];
  scope[key] = value;
  return () => {
    try {
      if (scope[key] !== value) return;
      if (had) scope[key] = previous;
      else delete scope[key];
    } catch {
      // a global made read-only since stays as it is
    }
  };
}

function isShim(value: unknown): boolean {
  return typeof value === 'function' && (value as unknown as Record<symbol, unknown>)[SHIM] === true;
}

function isStore(value: unknown): value is ReduxStoreLike {
  const store = value as Partial<ReduxStoreLike> | null;
  return (
    store !== null &&
    (typeof store === 'object' || typeof store === 'function') &&
    typeof store.getState === 'function' &&
    typeof store.dispatch === 'function' &&
    typeof store.subscribe === 'function'
  );
}

function nameOf(options: unknown): string | undefined {
  try {
    const name = (options as { name?: unknown } | null | undefined)?.name;
    return typeof name === 'string' && name !== '' ? name : undefined;
  } catch {
    return undefined;
  }
}

function copy(options: unknown): Record<string, unknown> {
  return options !== null && typeof options === 'object' ? { ...(options as Record<string, unknown>) } : {};
}
