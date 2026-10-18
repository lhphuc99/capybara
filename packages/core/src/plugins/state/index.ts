import type {
  StateChangePayload,
  StateCommands,
  StateEntryOp,
  StateEntrySummary,
  StateStoreInfo,
} from '@capybara-devtools/protocol';
import { getActiveClient, type Plugin } from '../../client.js';
import { serialize } from '../../serialize.js';
import { trackContexts, type ContextTracker } from './context.js';
import { createStateEngine, diffState, readPath, type StateEngine } from './engine.js';
import { installReduxShim } from './redux.js';
import { attach } from './registry.js';

/** Where a driver reports changes. Each call is O(1), only keeping a reference or marking a key, and never throws. */
export interface StateSink {
  /** The store's new state, and the action that made it when there is one. */
  record(id: string, state: unknown, action?: unknown, cause?: StateChangePayload['cause']): void;
  /** An entry changed. `low` for noise that can wait a second, such as observer updates. */
  dirty(id: string, key: string, low?: boolean): void;
  removed(id: string, key: string): void;
}

/**
 * One store, query client or cache, as an adapter registers it. Stores with a timeline (Redux, Zustand,
 * Context) have `getState`; caches (TanStack Query, SWR) have `keys` and `summarize`.
 */
export interface StoreDriver {
  info: Omit<StateStoreInfo, 'id'>;
  /** Read when the store is attached, as the base of its first diff, and on each `get`. */
  getState?(): unknown;
  /** Keys of the entries to show. */
  keys?(): Iterable<string>;
  summarize?(key: string): StateEntrySummary | undefined;
  data?(key: string): unknown;
  act?(key: string, op: StateEntryOp): Promise<{ done: boolean; note?: string }>;
  /**
   * Runs only while a client runs, so a store registered without one costs nothing. `id` is the one
   * `register` returns, given here too because `start` can run before `register` has returned.
   * Returns a function that stops reporting.
   */
  start(sink: StateSink, id: string): (() => void) | void;
}

export interface StatePluginOptions {
  /**
   * Stand in for the Redux DevTools extension, or wrap it when installed, so stores from Redux Toolkit's
   * configureStore() and zustand's devtools() show up on their own. Default true. Where the extension is
   * missing, this turns devtools() on, and each zustand `set` without an action name then builds a stack
   * trace to find one; pass false to avoid that.
   */
  redux?: boolean;
  /** Records past this many per second for one store are folded into the next one. Default 30. */
  maxActionsPerSecond?: number;
  /** Action types to keep off the timeline; a string matches the whole type. Their changes show in the next record. */
  actionsDenylist?: Array<string | RegExp>;
  /** Runs before a state is diffed or read, e.g. to blank out tokens; only what it returns leaves the app. */
  sanitizeState?: (state: unknown, store: StateStoreInfo) => unknown;
  sanitizeAction?: (action: unknown, store: StateStoreInfo) => unknown;
  /** Leave out keys that hold functions, such as Zustand actions. Default true. */
  hideFunctions?: boolean;
  /**
   * Show React Context providers, each change of their value with a diff, read through React DevTools' global
   * hook from development builds of React. Default true. Without React DevTools or Fast Refresh, `init()` must
   * run before react-dom loads.
   */
  context?: boolean;
}

export function statePlugin(options: StatePluginOptions = {}): Plugin {
  let engine: StateEngine | null = null;
  let contexts: ContextTracker | null = null;
  const running = (): StateEngine => {
    if (!engine) throw new Error('The state plugin is not running');
    return engine;
  };

  return {
    name: 'state',
    setup(ctx) {
      // Here rather than at import: the packages declare no side effects, so bundlers may drop such an import.
      const unshim = options.redux === false ? () => {} : installReduxShim();
      const tracker = options.context === false ? null : trackContexts(ctx);
      contexts = tracker;
      // The client becomes the active one only after setup, so this is read when the engine flushes.
      const connected = () => getActiveClient()?.connected === true;
      const current = createStateEngine(ctx.emit, { ...options, connected }, serialize, diffState, readPath);
      engine = current;
      const detach = attach(current);
      // Drivers stay registered, so the next client picks them up again; context stores are found again instead.
      return () => {
        unshim();
        tracker?.stop();
        if (contexts === tracker) contexts = null;
        detach();
        current.dispose();
        if (engine === current) engine = null;
      };
    },
    commands: {
      stores: (): StateStoreInfo[] => {
        const list = running().stores();
        const tracker = contexts;
        return tracker ? list.map((store) => (store.library === 'context' ? tracker.info(store) : store)) : list;
      },
      get: (params: StateCommands['get']['params']) => running().read(params?.store, params?.path),
      entries: (params: StateCommands['entries']['params']) => running().entries(params?.store),
      entry: (params: StateCommands['entry']['params']) => running().entry(params?.store, params?.key, params?.path),
      act: (params: StateCommands['act']['params']) => running().act(params?.store, params?.key, params?.op),
    },
  };
}
