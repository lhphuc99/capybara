import type { StateEngine } from './engine.js';
import type { StoreDriver } from './index.js';

/**
 * Where registered stores live. On `globalThis` so adapters can run before or after `init()`, and stores
 * outlive hot reloads, a client stopped and started again, and a second copy of the SDK in the bundle.
 * The name carries the version of the shape: changing the shape means a new name.
 */
export const REGISTRY_GLOBAL = '__CAPYBARA_STATE_V1__';
/** Hot reload re-creates a store under the same label; the older instances make way. */
const MAX_INSTANCES = 3;
const MAX_STORES = 100;

/** What the registry calls on the running client's engine. Shared through the global, so its shape is fixed. */
export type RegistrySink = Pick<StateEngine, 'track' | 'untrack'>;

interface Slot {
  info: StoreDriver['info'];
  driver: { deref(): StoreDriver | undefined };
}

interface Registry {
  version: 1;
  /** Registered stores by id, oldest first. */
  stores: Map<string, Slot>;
  /** Id of each registered target (or driver, when there is no target), so registering again returns it. */
  ids: WeakMap<object, string>;
  /** Keeps each driver alive exactly as long as its target. */
  keep: WeakMap<object, StoreDriver>;
  /** Last number given out per library, for ids such as "redux:2". */
  counts: Record<string, number>;
  sink: RegistrySink | null;
}

function registry(): Registry {
  const scope = globalThis as Record<string, unknown>;
  let reg = scope[REGISTRY_GLOBAL] as Registry | undefined;
  if (!reg) {
    reg = { version: 1, stores: new Map(), ids: new WeakMap(), keep: new WeakMap(), counts: {}, sink: null };
    scope[REGISTRY_GLOBAL] = reg;
  }
  return reg;
}

/**
 * Adds a store and returns its id, e.g. "zustand:2"; undefined where there is no `window` (server
 * rendering, Node). Pass the store, client or cache the driver reads as `target`: registering the same
 * target again then returns the same id, and the driver is held only as long as the target lives.
 * Without a target the driver is held until it is unregistered or pushed out by the caps.
 */
export function register(driver: StoreDriver, target?: object): string | undefined {
  if (typeof window === 'undefined') return undefined;
  let id: string;
  try {
    const reg = registry();
    const key = target ?? driver;
    const known = reg.ids.get(key);
    if (known !== undefined && reg.stores.has(known)) return known;
    sweep(reg);
    const { library, label } = driver.info;
    const twins = [...reg.stores].filter(([, slot]) => slot.info.library === library && slot.info.label === label);
    for (const [old] of twins.slice(0, Math.max(0, twins.length - (MAX_INSTANCES - 1)))) dispose(reg, old);
    while (reg.stores.size >= MAX_STORES) {
      dispose(reg, reg.stores.keys().next().value!, `Dropped to stay under ${MAX_STORES} stores`);
    }
    const n = (reg.counts[library] ?? 0) + 1;
    reg.counts[library] = n;
    id = `${library}:${n}`;
    let held: Slot['driver'] = { deref: () => driver };
    if (target && typeof WeakRef === 'function') {
      reg.keep.set(target, driver);
      held = new WeakRef(driver);
    }
    reg.stores.set(id, { info: driver.info, driver: held });
    reg.ids.set(key, id);
  } catch {
    return undefined;
  }
  try {
    registry().sink?.track(id, driver);
  } catch {
    // the engine reports its own failures as a disposed store
  }
  return id;
}

/** Removes a store, e.g. when an adapter's untrack function runs. */
export function unregister(id: string): void {
  if (typeof window === 'undefined') return;
  dispose(registry(), id);
}

/** Has `sink` watch every registered store, and the ones registered later. Returns the undo. */
export function attach(sink: RegistrySink): () => void {
  const reg = registry();
  sweep(reg);
  reg.sink = sink;
  for (const [id, slot] of [...reg.stores]) {
    const driver = slot.driver.deref();
    if (!driver) continue;
    try {
      sink.track(id, driver);
    } catch {
      // keep attaching the rest
    }
  }
  return () => {
    if (reg.sink === sink) reg.sink = null;
  };
}

// Hermes may lack FinalizationRegistry, so collected stores are found by looking, whenever stores change.
function sweep(reg: Registry): void {
  for (const [id, slot] of [...reg.stores]) {
    if (!slot.driver.deref()) dispose(reg, id);
  }
}

function dispose(reg: Registry, id: string, note?: string): void {
  if (!reg.stores.delete(id)) return;
  try {
    reg.sink?.untrack(id, note);
  } catch {
    // nothing to report then
  }
}
