import type { StateStoreInfo } from '@capybara-devtools/protocol';
import type { PluginContext } from '../../client.js';
import type { StateSink, StoreDriver } from './index.js';
import { register, unregister } from './registry.js';
import { contextName, ownerName, vendorOf } from './context-names.js';
import { HOST_ROOT, walkProviders, type Fiber, type FiberRoot, type ProviderHit, type WalkCursor } from './fibers.js';
import { installReactHook } from './react-hook.js';

/** Per discovery step, so a large tree never blocks a frame: walking time, then providers to set up. */
const CHUNK_MS = 5;
const CHUNK_PROVIDERS = 250;
/** Unmounted providers are looked for at most this often, after a commit that removed something. */
const SWEEP_MS = 2_000;
/** Instance counts are sent once they settle, since a list can mount many providers one commit after another. */
const ANNOUNCE_MS = 300;
/** Context stores never take most of the registry's 100 places from the app's other stores. */
const MAX_APP_CONTEXTS = 40;
const MAX_LIBRARY_CONTEXTS = 20;

/** Up to this many providers under one name, the store's state holds each one's value; past it, the latest one. */
const MAX_KEYED = 20;

interface Instance {
  group: Group;
  /** Either copy of the provider's fiber. */
  fiber: Fiber;
  value: unknown;
  /** Its key in the state of a store with several providers: the React key of the provider or of a component above it, else `#n`. */
  key: string;
}

/** Providers of one context under one name: one store. */
interface Group {
  context: object;
  name: string;
  label: string;
  vendor: string | undefined;
  instances: Set<Instance>;
  /** Instances that took each key so far, so keys stay unique and are never reused. */
  keys: Map<string, number>;
  /** The value that changed last: the state of a store with more than `MAX_KEYED` providers. */
  latest: unknown;
  /** As last recorded, or as the engine read it when it started watching. */
  state: unknown;
  driver: StoreDriver;
  /** From the registry; undefined while over the cap. */
  id: string | undefined;
  sink: StateSink | null;
  storeId: string | undefined;
  live: boolean;
  /** Found by the walk under way, and registered once it ends, with the instances it found. */
  fresh: boolean;
}

interface RootState {
  /** Set while the first walk of the tree is still going. */
  cursor: WalkCursor | null;
  commits: number;
  ignored: boolean;
}

export interface ContextTracker {
  /** The store's info as it is now; the engine keeps the one it was first given. */
  info(store: StateStoreInfo): StateStoreInfo;
  stop(): void;
}

/**
 * Shows the React Context providers the app mounts as stores, one per context and name. The state is the provider's
 * value, or with several providers each one's value by key. Read only, and only from development builds of React.
 */
export function trackContexts(ctx: Pick<PluginContext, 'emit' | 'console'>): ContextTracker {
  const seen = new WeakMap<object, unknown>();
  const instances = new WeakMap<object, Instance>();
  const groups = new Map<object, Map<string, Group>>();
  const labels = new Map<string, Group>();
  const byId = new Map<string, Group>();
  const roots = new WeakMap<object, RootState>();
  const numbers = new WeakMap<object, number>();
  const counts = { app: 0, library: 0 };
  const announcing = new Set<Group>();
  const fresh: Group[] = [];
  /** Stores whose state may have changed, recorded once the walk under way ends. */
  const dirty = new Set<Group>();
  /** Roots whose first walk is still going; stores found meanwhile wait for it, to be announced once. */
  let discovering = 0;
  let numbered = 0;
  let stopped = false;
  let lastSweep = 0;
  let sweepTimer: ReturnType<typeof setTimeout> | null = null;
  let announceTimer: ReturnType<typeof setTimeout> | null = null;

  const all = (): Group[] => [...groups.values()].flatMap((byName) => [...byName.values()]);
  const later = (run: () => void, ms: number) =>
    setTimeout(() => {
      if (stopped) return;
      try {
        run();
      } catch (error) {
        fail(error);
      }
    }, ms);

  const announce = (group: Group, extra?: Partial<StateStoreInfo>) => {
    if (group.sink === null || group.storeId === undefined) return;
    ctx.emit('state.store', { store: { ...group.driver.info, ...extra, id: group.storeId } });
  };
  /** Whether the count changed. */
  const count = (group: Group): boolean => {
    const size = group.instances.size;
    const info = group.driver.info;
    if ((info.instances ?? 1) === size) return false;
    if (size > 1) info.instances = size;
    else delete info.instances;
    return true;
  };
  const recount = (group: Group) => {
    if (!count(group) || group.fresh) return;
    announcing.add(group);
    announceTimer ??= later(() => {
      announceTimer = null;
      for (const pending of announcing) if (pending.live) announce(pending);
      announcing.clear();
    }, ANNOUNCE_MS);
  };

  /**
   * One provider's value, or each one's by key: one value standing for several would make each diff compare one
   * provider with another. Very many, such as React Native's one per `<Text>` that holds elements, keep the latest value.
   */
  const stateOf = (group: Group): unknown => {
    const size = group.instances.size;
    if (size === 1) return group.instances.values().next().value!.value;
    if (size > MAX_KEYED) return group.latest;
    const state: Record<string, unknown> = {};
    for (const instance of group.instances) state[instance.key] = instance.value;
    return state;
  };
  /** Records the stores that changed, once each: a list that renders again changes all its providers in one commit. */
  const flush = () => {
    for (const group of dirty) {
      if (!group.live || group.fresh) continue;
      const next = stateOf(group);
      if (next === group.state) continue;
      group.state = next;
      if (group.sink !== null && group.storeId !== undefined) group.sink.record(group.storeId, next, undefined, 'set');
    }
    dirty.clear();
  };

  const enroll = (group: Group) => {
    const kind = group.vendor === undefined ? 'app' : 'library';
    if (counts[kind] >= (kind === 'app' ? MAX_APP_CONTEXTS : MAX_LIBRARY_CONTEXTS)) return;
    group.id = register(group.driver);
    if (group.id === undefined) return;
    counts[kind]++;
    byId.set(group.id, group);
  };
  const settle = () => {
    flush();
    if (discovering > 0) return;
    for (const group of fresh.splice(0)) {
      group.fresh = false;
      if (!group.live) continue;
      count(group);
      group.state = stateOf(group);
      enroll(group);
    }
  };
  const dispose = (group: Group) => {
    group.live = false;
    const byName = groups.get(group.context);
    byName?.delete(group.name);
    if (byName?.size === 0) groups.delete(group.context);
    if (labels.get(group.label) === group) labels.delete(group.label);
    announcing.delete(group);
    dirty.delete(group);
    if (group.id === undefined) return;
    counts[group.vendor === undefined ? 'app' : 'library']--;
    byId.delete(group.id);
    unregister(group.id);
  };
  const prune = (group: Group) => {
    let lost = false;
    for (const instance of [...group.instances]) {
      if (mounted(instance.fiber)) continue;
      group.instances.delete(instance);
      lost = true;
    }
    if (group.instances.size === 0) dispose(group);
    else if (lost) {
      recount(group);
      dirty.add(group);
    }
  };
  const sweep = () => {
    sweepTimer = null;
    lastSweep = Date.now();
    for (const group of all()) prune(group);
    flush();
  };
  const sweepSoon = () => {
    if (sweepTimer !== null) return;
    sweepTimer = later(sweep, Math.max(0, lastSweep + SWEEP_MS - Date.now()));
  };

  /** One label per context, so the registry never takes two contexts for hot-reloaded copies of one store. */
  const labelFor = (name: string, context: object): string => {
    for (let n = 1; ; n++) {
      const label = n === 1 ? name : `${name} #${n}`;
      const holder = labels.get(label);
      if (holder?.live) prune(holder);
      if (!holder?.live || holder.context === context) return label;
    }
  };
  const nameFor = (fiber: Fiber, context: object): string => {
    const name = contextName(context) ?? ownerName(fiber);
    if (name !== undefined) return name;
    let n = numbers.get(context);
    if (n === undefined) numbers.set(context, (n = ++numbered));
    return `Context #${n}`;
  };
  const keyFor = (fiber: Fiber, group: Group): string => {
    let base: string | undefined;
    // A list keys the provider itself or the component that renders it.
    for (let node: Fiber | null = fiber, hops = 0; node != null && hops < 6 && base === undefined; node = node.return, hops++) {
      if (node.key != null) base = String(node.key);
    }
    const n = (group.keys.get(base ?? '#') ?? 0) + 1;
    group.keys.set(base ?? '#', n);
    if (base === undefined) return `#${n}`;
    return n === 1 ? base : `${base} #${n}`;
  };

  const add = (fiber: Fiber, context: object, value: unknown) => {
    const name = nameFor(fiber, context);
    let byName = groups.get(context);
    let group = byName?.get(name);
    if (!group) {
      const vendor = vendorOf(fiber, context, value);
      const label = labelFor(name, context);
      const created: Group = {
        context,
        name,
        label,
        vendor,
        instances: new Set(),
        keys: new Map(),
        latest: value,
        state: undefined,
        id: undefined,
        sink: null,
        storeId: undefined,
        live: true,
        fresh: true,
        driver: {
          info: { library: 'context', label, via: 'fiber', actions: false, ...(vendor !== undefined && { vendor }) },
          getState: () => created.state,
          start(sink, id) {
            created.sink = sink;
            created.storeId = id;
            return () => {
              if (created.sink === sink) created.sink = null;
            };
          },
        },
      };
      group = created;
      if (!byName) groups.set(context, (byName = new Map()));
      byName.set(name, group);
      labels.set(label, group);
      fresh.push(group);
    }
    const instance: Instance = { group, fiber, value, key: keyFor(fiber, group) };
    instances.set(fiber, instance);
    if (fiber.alternate) instances.set(fiber.alternate, instance);
    group.instances.add(instance);
    dirty.add(group);
    recount(group);
  };
  const handle = (hit: ProviderHit) => {
    const fiber = hit.fiber;
    let instance = instances.get(fiber);
    if (!instance && fiber.alternate) {
      instance = instances.get(fiber.alternate);
      if (instance) instances.set(fiber, instance);
    }
    if (instance?.group.live) {
      instance.fiber = fiber;
      const { value } = hit;
      if (instance.value === value || (instance.value !== instance.value && value !== value)) return;
      instance.value = value;
      instance.group.latest = value;
      dirty.add(instance.group);
      return;
    }
    if (hit.context !== null && typeof hit.context === 'object') add(fiber, hit.context, hit.value);
  };

  const step = (root: FiberRoot, state: RootState) => {
    const result = walkProviders(root, seen, { budget: CHUNK_MS, limit: CHUNK_PROVIDERS, from: state.cursor });
    for (const hit of result.providers) handle(hit);
    state.cursor = result.next;
    if (!state.cursor) discovering--;
    settle();
    if (state.cursor) {
      later(() => step(root, state), 0);
      return;
    }
    // Commits during the walk can unmount parts of the tree it had yet to reach.
    if (state.commits > 0) sweepSoon();
  };
  const discover = (root: FiberRoot) => {
    const current = root?.current;
    // `_debugOwner` exists only in development builds.
    const ignored = current == null || current.tag !== HOST_ROOT || !('_debugOwner' in current);
    const state: RootState = { cursor: null, commits: 0, ignored };
    roots.set(root, state);
    if (ignored) return;
    discovering++;
    step(root, state);
  };
  const onCommit = (root: FiberRoot) => {
    if (stopped || root === null || typeof root !== 'object') return;
    try {
      const state = roots.get(root);
      if (!state) return discover(root);
      if (state.ignored) return;
      if (state.cursor) state.commits++;
      const result = walkProviders(root, seen, { changed: true });
      for (const hit of result.providers) handle(hit);
      settle();
      if (result.removed) sweepSoon();
    } catch (error) {
      fail(error);
    }
  };

  const halt = () => {
    stopped = true;
    installed.undo();
    if (sweepTimer !== null) clearTimeout(sweepTimer);
    if (announceTimer !== null) clearTimeout(announceTimer);
  };
  // React internals changed shape, or a bug: stop for good rather than fail on every commit. The stores stay, with a note.
  const fail = (error: unknown) => {
    if (stopped) return;
    const note = `Stopped watching React Context: ${error instanceof Error ? error.message : String(error)}`;
    for (const group of all()) announce(group, { note });
    ctx.console.warn(`[capybara] ${note}`);
    halt();
  };

  const installed = installReactHook(onCommit);
  // A hook from React DevTools (always there in React Native) knows the trees mounted already.
  const hook = installed.hook;
  if (hook && hook.renderers instanceof Map && hook.renderers.size > 0 && typeof hook.getFiberRoots === 'function') {
    later(() => {
      for (const id of [...(hook.renderers as Map<unknown, unknown>).keys()]) {
        for (const root of [...hook.getFiberRoots!(id)]) {
          if (root !== null && typeof root === 'object' && !roots.has(root)) discover(root as FiberRoot);
        }
      }
    }, 0);
  }

  return {
    info(store) {
      const group = byId.get(store.id);
      return group?.live ? { ...group.driver.info, id: store.id } : store;
    },
    stop() {
      if (!stopped) halt();
      for (const group of all()) dispose(group);
    },
  };
}

/** Whether the fiber, or its other copy, still hangs from a root: React cuts removed subtrees loose. */
function mounted(fiber: Fiber): boolean {
  const reaches = (start: Fiber | null) => {
    let node = start;
    for (let hops = 0; node != null && hops < 100_000; hops++) {
      if (node.tag === HOST_ROOT) return true;
      node = node.return;
    }
    return false;
  };
  return reaches(fiber) || reaches(fiber.alternate);
}
