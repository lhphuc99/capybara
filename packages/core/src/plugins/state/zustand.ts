import type { StoreDriver } from './index.js';
import { defaultLabel, reduxShimActive } from './redux.js';
import { register, unregister } from './registry.js';

/** What Capybara reads of a zustand store: one from `createStore`, or the hook `create` returns. Zustand 4.5 and later. */
export interface ZustandStoreLike {
  getState(): unknown;
  setState(...args: any[]): unknown;
  subscribe(listener: (state: any, previousState: any) => void): () => void;
}

export interface WatchZustandOptions {
  /** Shown in the State tab. Defaults to the name given to the persist middleware, then "zustand #n". */
  name?: string;
  /** Watch a devtools() store although the Redux DevTools shim shows it already, with action names. */
  force?: boolean;
}

/** Stores watched, by `getState`, which the hook from `create` shares with its store. */
const watched = new WeakMap<object, { driver: StoreDriver; id: string | undefined }>();

/** Redux stores have getState and subscribe too, but replaceReducer instead of setState. */
export function isZustandLike(value: unknown): value is ZustandStoreLike {
  const store = value as (Partial<ZustandStoreLike> & { replaceReducer?: unknown }) | null;
  return (
    store !== null &&
    (typeof store === 'object' || typeof store === 'function') &&
    typeof store.getState === 'function' &&
    typeof store.setState === 'function' &&
    typeof store.subscribe === 'function' &&
    typeof store.replaceReducer !== 'function'
  );
}

/**
 * Shows a zustand store in the State tab, each change as a diff without an action name. Stores made with the
 * devtools() middleware after `init()` show up on their own, with action names, so they are skipped here
 * unless `force` is set. Returns a function that undoes this call.
 */
export function watchZustand(store: ZustandStoreLike, options: WatchZustandOptions = {}): () => void {
  if (typeof window === 'undefined' || !isZustandLike(store)) return () => {};
  try {
    // devtools() sets `devtools.cleanup` once connected. With the shim installed, that is taken to mean through it.
    const devtools = (store as { devtools?: { cleanup?: unknown } }).devtools;
    if (!options.force && typeof devtools?.cleanup === 'function' && reduxShimActive()) return () => {};
    const key = store.getState;
    const known = watched.get(key);
    if (known) {
      // The registry may have dropped it since, e.g. for a newer instance under the same label.
      known.id = register(known.driver, key) ?? known.id;
      return () => {};
    }
    const driver: StoreDriver = {
      info: { library: 'zustand', label: labelOf(store, options), via: 'subscribe', actions: false },
      getState: () => store.getState(),
      start: (sink, id) => store.subscribe((state) => sink.record(id, state, undefined, 'set')),
    };
    const entry = { driver, id: undefined as string | undefined };
    watched.set(key, entry);
    entry.id = register(driver, key);
    let undone = false;
    return () => {
      if (undone) return;
      undone = true;
      watched.delete(key);
      if (entry.id !== undefined) unregister(entry.id);
    };
  } catch {
    return () => {};
  }
}

function labelOf(store: ZustandStoreLike, options: WatchZustandOptions): string {
  if (typeof options.name === 'string' && options.name !== '') return options.name;
  try {
    const persisted = (store as { persist?: { getOptions?(): { name?: unknown } } }).persist?.getOptions?.().name;
    if (typeof persisted === 'string' && persisted !== '') return persisted;
  } catch {
    // numbered instead
  }
  return defaultLabel('zustand', store.getState());
}
