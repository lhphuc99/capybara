import type { StoreDriver } from './index.js';
import { defaultLabel } from './redux.js';
import { register, unregister } from './registry.js';

/** The functions of the `mobx` module Capybara uses, passed in so the SDK does not depend on MobX. */
export interface MobxLike {
  reaction(expression: () => unknown, effect: (value: any) => void): () => void;
  toJS(value: unknown): unknown;
  spy?(listener: (event: { type: string; name?: string; spyReportStart?: boolean; spyReportEnd?: boolean }) => void): () => void;
}

export interface WatchMobXOptions {
  /** Shown in the State tab. Defaults to "MobX store #n". */
  name?: string;
}

const watched = new WeakMap<object, { driver: StoreDriver; id: string | undefined }>();

/**
 * Shows a MobX observable, such as a store made with makeAutoObservable, in the State tab: each change as a diff,
 * named after the action that made it. Pass the mobx module, e.g. `import * as mobx from 'mobx'`. Returns a function
 * that undoes this call.
 */
export function watchMobX(store: object, mobx: MobxLike, options: WatchMobXOptions = {}): () => void {
  if (typeof window === 'undefined' || store === null || typeof store !== 'object') return () => {};
  if (typeof mobx?.reaction !== 'function' || typeof mobx.toJS !== 'function') return () => {};
  try {
    const known = watched.get(store);
    if (known) {
      known.id = register(known.driver, store) ?? known.id;
      return () => {};
    }
    const spy = typeof mobx.spy === 'function' ? mobx.spy : undefined;
    const driver: StoreDriver = {
      info: {
        library: 'mobx',
        label: typeof options.name === 'string' && options.name !== '' ? options.name : defaultLabel('mobx', mobx.toJS(store)),
        via: 'subscribe',
        actions: spy !== undefined,
      },
      getState: () => mobx.toJS(store),
      start(sink, id) {
        // The outermost action running. Reactions run when it ends, still inside its spy report.
        let action: string | undefined;
        let depth = 0;
        const stopSpy = spy?.((event) => {
          if (event.type === 'action' && depth === 0 && event.name && event.name !== '<unnamed action>') action = event.name;
          if (event.spyReportStart) depth++;
          if (event.spyReportEnd) {
            depth = Math.max(0, depth - 1);
            if (depth === 0) action = undefined;
          }
        });
        const stopReaction = mobx.reaction(
          () => mobx.toJS(store),
          (state) => sink.record(id, state, action === undefined ? undefined : { type: action }, action === undefined ? 'set' : 'action'),
        );
        return () => {
          stopReaction();
          stopSpy?.();
        };
      },
    };
    const entry = { driver, id: undefined as string | undefined };
    watched.set(store, entry);
    entry.id = register(driver, store);
    let undone = false;
    return () => {
      if (undone) return;
      undone = true;
      watched.delete(store);
      if (entry.id !== undefined) unregister(entry.id);
    };
  } catch {
    return () => {};
  }
}
