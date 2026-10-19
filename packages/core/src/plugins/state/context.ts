import type { StateStoreInfo } from '@capybara-devtools/protocol';
import type { PluginContext } from '../../client.js';
import type { StateSink, StoreDriver } from './index.js';
import { register, unregister } from './registry.js';

// React Context is read from React's own fibers, through the global hook React DevTools uses. Fibers are React
// internals; what is read here (tags, `child`, `sibling`, `alternate`, `memoizedProps`) is the same in React 18
// and 19, which were checked. Nothing is ever written to a fiber: React prevents extensions to them in development.

/** A React fiber, as far as Capybara reads one. */
export interface Fiber {
  tag: number;
  key?: string | null;
  type: any;
  /** memo() keeps the wrapper here and the function in `type`. */
  elementType?: any;
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
  memoizedProps: any;
  memoizedState?: any;
  /** Children this fiber removed in the commit that made it. */
  deletions?: Fiber[] | null;
  _debugOwner?: unknown;
  /** React 19: where the element was created. */
  _debugStack?: unknown;
  /** React 18 with the JSX source transform. */
  _debugSource?: unknown;
}

/** What React hands `onCommitFiberRoot`; `current` is the HostRoot fiber of the tree just committed. */
export interface FiberRoot {
  current: Fiber;
}

/** Where a walk cut short by its budget goes on from. */
export interface WalkCursor {
  top: Fiber;
  node: Fiber;
  /** Ancestors of `node` below `top`, outermost first. */
  stack: Fiber[];
}

export interface ProviderHit {
  fiber: Fiber;
  /** The context object, the same for every provider of one context. */
  context: unknown;
  value: unknown;
  /** Neither this fiber nor its alternate was in `seen` before. */
  first: boolean;
}

export interface WalkProvidersOptions {
  /**
   * Right after a commit: go only into subtrees whose children changed in it, and report known providers whose
   * value changed too. Without it, every fiber is visited and only providers missing from `seen` are reported.
   */
  changed?: boolean;
  /** Return after about this many milliseconds, with `next` to go on from. Default: no limit. */
  budget?: number;
  /** Return once this many providers are reported, with `next` to go on from. Default: no limit. */
  limit?: number;
  from?: WalkCursor | null;
  /** Called on every fiber visited, e.g. to look for stores in hooks. */
  visit?: (fiber: Fiber) => void;
  /** Clock for `budget`. Default `performance.now`, else `Date.now`. */
  now?: () => number;
}

export interface WalkProvidersResult {
  providers: ProviderHit[];
  visited: number;
  /** With `changed`: a fiber visited removed children in the commit, so some provider may be gone. */
  removed: boolean;
  /** Set when the budget ran out first. */
  next: WalkCursor | null;
}

/**
 * Finds context providers (tag 10) under `root`, a FiberRoot or a fiber. `seen` maps each provider fiber, and its
 * alternate, to the last value reported, and is updated as providers are reported.
 *
 * Self-contained, like the engine: the Metro bridge runs it from its source inside apps without the SDK. Iterative
 * with a stack of its own rather than `return` pointers, which may lead to the other copy of a parent.
 */
export function walkProviders(root: object, seen: WeakMap<object, unknown>, options: WalkProvidersOptions = {}): WalkProvidersResult {
  const PROVIDER = 10;
  const changed = options.changed === true;
  const visit = typeof options.visit === 'function' ? options.visit : undefined;
  const clock =
    typeof options.now === 'function'
      ? options.now
      : typeof performance === 'object' && performance !== null && typeof performance.now === 'function'
        ? () => performance.now()
        : () => Date.now();
  const budget = typeof options.budget === 'number' && options.budget >= 0 ? options.budget : Infinity;
  const deadline = budget === Infinity ? Infinity : clock() + budget;
  const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : Infinity;
  const from = options.from;
  const top: Fiber | null = from ? from.top : 'current' in root ? (root as FiberRoot).current : (root as Fiber);
  const stack: Fiber[] = from ? from.stack.slice() : [];
  const providers: ProviderHit[] = [];
  let visited = 0;
  let removed = false;
  let node: Fiber | null = from ? from.node : top;

  while (node != null) {
    visited++;
    if (node.tag === PROVIDER) {
      const type = node.type;
      // React 19 renders the context itself; React 18 renders `context.Provider`, which points back to it.
      const context = type != null && typeof type === 'object' && type._context != null ? type._context : type;
      const props = node.memoizedProps;
      const value = props != null && typeof props === 'object' ? props.value : undefined;
      const alternate = node.alternate;
      const own = seen.has(node);
      if (!own && (alternate == null || !seen.has(alternate))) {
        providers.push({ fiber: node, context, value, first: true });
        seen.set(node, value);
        if (alternate != null) seen.set(alternate, value);
      } else if (changed) {
        const last = own ? seen.get(node) : seen.get(alternate as Fiber);
        if (!(last === value || (last !== last && value !== value))) {
          providers.push({ fiber: node, context, value, first: false });
          seen.set(node, value);
          if (alternate != null) seen.set(alternate, value);
        } else if (!own) {
          seen.set(node, value);
        }
      }
    }
    if (changed && !removed && node.deletions != null && node.deletions.length > 0) removed = true;
    if (visit) visit(node);

    let child: Fiber | null = node.child;
    // A subtree that bailed out keeps its child fiber, so nothing under it changed in this commit.
    if (changed && child != null && node.alternate != null && node.alternate.child === child) child = null;
    if (child != null) {
      stack.push(node);
      node = child;
    } else {
      let next: Fiber | null = null;
      while (node != null && node !== top) {
        if (node.sibling != null) {
          next = node.sibling;
          break;
        }
        node = stack.length > 0 ? stack.pop()! : null;
      }
      node = next;
    }
    if (
      node != null &&
      top != null &&
      (providers.length >= limit || (deadline !== Infinity && (visited & 127) === 0 && clock() >= deadline))
    ) {
      return { providers, visited, removed, next: { top, node, stack } };
    }
  }
  return { providers, visited, removed, next: null };
}

// ---------------------------------------------------------------------------
// The global hook
// ---------------------------------------------------------------------------

const HOOK = '__REACT_DEVTOOLS_GLOBAL_HOOK__';
const HOST_ROOT = 3;

/** React DevTools' global hook, as far as Capybara uses it. */
export interface ReactHook {
  isDisabled?: unknown;
  renderers?: unknown;
  getFiberRoots?: (rendererID: unknown) => Iterable<unknown>;
  onCommitFiberRoot?: unknown;
}

/**
 * Has `onCommit` called after each commit React reports to the React DevTools global hook. An existing hook keeps
 * its object, which React holds on to: only its `onCommitFiberRoot` property is wrapped, the original called
 * first. Without a hook, installs a minimal one, which only works when this runs before react-dom loads.
 * Returns the undo, which leaves a wrapper someone else wrapped since in place, passing calls on.
 */
export function installReactHook(onCommit: (root: FiberRoot) => void): { hook: ReactHook | undefined; undo: () => void } {
  const none = { hook: undefined, undo: () => {} };
  if (typeof window === 'undefined') return none;
  try {
    // Where React looks the hook up; the same object as `window` in browsers and React Native.
    const scope = globalThis as Record<string, unknown>;
    let hook = scope[HOOK] as ReactHook | null | undefined;
    if (hook === undefined) {
      hook = minimalHook();
      Object.defineProperty(scope, HOOK, { value: hook, configurable: true, writable: true, enumerable: false });
      if (scope[HOOK] !== hook) return none;
    }
    // `isDisabled` opts out of DevTools; React then never calls the hook, so there is nothing to wrap.
    if (hook === null || typeof hook !== 'object' || hook.isDisabled) return none;
    const target = hook;
    const original = target.onCommitFiberRoot;
    let active = true;
    const wrapper = function (this: unknown, ...args: unknown[]) {
      try {
        if (typeof original === 'function') return original.apply(this, args);
      } finally {
        if (active) {
          try {
            onCommit(args[1] as FiberRoot);
          } catch {
            // never throw into React's commit
          }
        }
      }
    };
    target.onCommitFiberRoot = wrapper;
    if (target.onCommitFiberRoot !== wrapper) return none;
    return {
      hook: target,
      undo: () => {
        active = false;
        try {
          if (target.onCommitFiberRoot === wrapper) target.onCommitFiberRoot = original;
        } catch {
          // a hook frozen since keeps the wrapper, which now only passes calls on
        }
      },
    };
  } catch {
    return none;
  }
}

/**
 * What React needs of the hook, plus what React Refresh and DevTools read when they load later: `renderers`
 * filled by `inject`, and `getFiberRoots`. No `checkDCE`, so React still suggests installing DevTools.
 */
function minimalHook(): ReactHook {
  const renderers = new Map<number, unknown>();
  const roots = new Map<number, Set<FiberRoot>>();
  let nextId = 0;
  const getFiberRoots = (id: number) => {
    let mounted = roots.get(id);
    if (!mounted) roots.set(id, (mounted = new Set()));
    return mounted;
  };
  return {
    renderers,
    supportsFiber: true,
    inject: (renderer: unknown) => {
      const id = ++nextId;
      renderers.set(id, renderer);
      return id;
    },
    getFiberRoots,
    // Keeps mounted roots the way React DevTools does, so a client started later finds them.
    onCommitFiberRoot: (id: number, root: FiberRoot) => {
      const state = root?.current?.memoizedState as { element?: unknown } | null | undefined;
      if (state == null || state.element == null) getFiberRoots(id).delete(root);
      else getFiberRoots(id).add(root);
    },
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
  } as ReactHook;
}

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);

function contextName(context: object): string | undefined {
  try {
    const name = (context as { displayName?: unknown }).displayName;
    return typeof name === 'string' && name !== '' ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The component that rendered the provider: its owner, which development builds keep, else the closest one above.
 * `owned` keeps to the owner, for an element created outside any render (e.g. passed to `root.render()`) has none.
 */
function ownerName(fiber: Fiber, owned = false): string | undefined {
  try {
    for (let owner = fiber._debugOwner as Fiber | { name?: unknown } | null | undefined, hops = 0; owner != null && hops < 20; hops++) {
      // A Server Component owner is plain info with a name.
      if (!('tag' in owner)) return typeof owner.name === 'string' && owner.name !== '' ? owner.name : undefined;
      const name = componentName(owner);
      if (name !== undefined) return name;
      owner = owner._debugOwner as Fiber | null | undefined;
    }
    if (owned) return undefined;
    for (let node = fiber.return, hops = 0; node != null && hops < 50; node = node.return, hops++) {
      if (!COMPONENT_TAGS.has(node.tag)) continue;
      const name = componentName(node);
      if (name !== undefined) return name;
    }
  } catch {
    // a getter that threw: numbered instead
  }
  return undefined;
}

function componentName(fiber: Fiber): string | undefined {
  if (!COMPONENT_TAGS.has(fiber.tag)) return undefined;
  // memo() and forwardRef() wrap the function, sometimes one inside the other.
  let type = fiber.elementType ?? fiber.type;
  for (let depth = 0; type != null && depth < 3; depth++) {
    const name: unknown = type.displayName ?? (typeof type === 'function' ? type.name : undefined);
    // Bundlers rename clashing functions with a suffix, e.g. Vite's pre-bundling turns SWRConfig into SWRConfig$1.
    if (typeof name === 'string' && name !== '') return name.replace(/\$\d+$/, '') || name;
    if (typeof type !== 'object') return undefined;
    type = type.render ?? type.type;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Library contexts
// ---------------------------------------------------------------------------

/** Contexts that libraries name, by display name. */
const LIBRARY_CONTEXTS = new Map(Object.entries({
  ReactRedux: 'react-redux',
  TextAncestorContext: 'React Native',
  RootTagContext: 'React Native',
  ScrollViewContext: 'React Native',
  VirtualizedListContext: 'React Native',
  ImageAnalyticsTagContext: 'React Native',
  SafeAreaInsetsContext: 'react-native-safe-area-context',
  SafeAreaFrameContext: 'react-native-safe-area-context',
  LinkingContext: 'React Navigation',
  LocaleDirContext: 'React Navigation',
  UnhandledLinkingContext: 'React Navigation',
  HeaderBackContext: 'React Navigation',
  HeaderHeightContext: 'React Navigation',
  HeaderShownContext: 'React Navigation',
  NavigatorContext: 'Expo Router',
  RouteNode: 'Expo Router',
}));

/** Where React Navigation keeps the contexts it names, so that two copies of it share them. */
const REACT_NAVIGATION_CONTEXTS = '__react_navigation__elements_contexts';

/** Library components that render providers, by the names their code gives them. Names an app might use are left out. */
const LIBRARY_COMPONENTS = new Map(Object.entries({
  QueryClientProvider: 'TanStack Query',
  QueryErrorResetBoundary: 'TanStack Query',
  PersistQueryClientProvider: 'TanStack Query',
  HydrationBoundary: 'TanStack Query',
  SWRConfig: 'SWR',
  BaseNavigationContainer: 'React Navigation',
  NavigationContainerInner: 'React Navigation',
  NavigationIndependentTree: 'React Navigation',
  NavigationProvider: 'React Navigation',
  NavigationStateListenerProvider: 'React Navigation',
  PreventRemoveProvider: 'React Navigation',
  EnsureSingleNavigator: 'React Navigation',
  SceneView: 'React Navigation',
  ServerContainer: 'React Navigation',
  FrameSizeProvider: 'React Navigation',
  AnimatedHeaderHeightProvider: 'React Navigation',
  BottomTabView: 'React Navigation',
  CardContainerInner: 'React Navigation',
  DrawerViewBase: 'React Navigation',
  NativeStackView: 'React Navigation',
  MaterialTopTabView: 'React Navigation',
  NavigationContent: 'React Navigation',
  PanGestureHandler: 'React Navigation',
  ExpoRoot: 'Expo Router',
  ContextNavigator: 'Expo Router',
  InnerRoot: 'Expo Router',
  RootModalProvider: 'Expo Router',
  LinkPreviewContextProvider: 'Expo Router',
  NativeTabsNavigator: 'Expo Router',
  SlotNavigator: 'Expo Router',
  SplitViewNavigator: 'Expo Router',
  ExperimentalStackNavigator: 'Expo Router',
  ZoomTransitionSourceContextProvider: 'Expo Router',
  ZoomTransitionTargetContextProvider: 'Expo Router',
  // Expo Router 58, which carries its own copy of React Navigation.
  RoutingQueueProvider: 'Expo Router',
  RemovalEventEmitterRegistryProvider: 'Expo Router',
  RoutesWithRemovalPreventedProvider: 'Expo Router',
  PreventRemovalProvider: 'Expo Router',
  GuardContextProvider: 'Expo Router',
  NavigationActivityProvider: 'Expo Router',
  StandardRouterNavigator: 'Expo Router',
  NativeTabsNavigatorWrapper: 'Expo Router',
  NativeTabsContent: 'Expo Router',
  NativeStackNavigatorContent: 'Expo Router',
  ExperimentalStackNavigatorContent: 'Expo Router',
  HeaderToolbarHostBase: 'Expo Router',
  StackToolbarHeader: 'Expo Router',
  StackToolbarBottom: 'Expo Router',
  NativeToolbarMenu: 'Expo Router',
  LinkWithPreview: 'Expo Router',
  HrefPreview: 'Expo Router',
  PreviewForRootHrefState: 'Expo Router',
  InnerRouter: 'Expo Router',
  FocusedHead: 'Expo Router',
  HeadShim: 'Expo Router',
  WebSafeAreaProvider: 'Expo Router',
  ServerRoot: 'Expo Router',
  ServerRouter: 'Expo Router',
  ServerDocument: 'Expo Router',
  SafeAreaProvider: 'react-native-safe-area-context',
  ScreenStack: 'react-native-screens',
  ScreenStackItem: 'react-native-screens',
  InnerScreen: 'react-native-screens',
  GestureDetectorProvider: 'react-native-screens',
  ReanimatedScreenProvider: 'react-native-screens',
  ReanimatedNativeStackScreen: 'react-native-screens',
  GestureHandlerRootView: 'react-native-gesture-handler',
  InterceptingGestureDetector: 'react-native-gesture-handler',
  ScrollViewResponderProvider: 'react-native-gesture-handler',
  SkipEntering: 'react-native-reanimated',
  AppContainer: 'React Native',
}));

/** Expo Router names each route's component after the route, e.g. `Route(index)`. */
const EXPO_ROUTE = /^Route\(.*\)$/;

/**
 * Library components whose names an app might use too, recognized by the component that rendered them: Expo
 * Router's `Content` comes from ContextNavigator, its `Route` from a route's own component.
 */
const LIBRARY_COMPONENTS_BY_OWNER = new Map<string, (owner: string) => boolean>([
  ['Content', (owner) => owner === 'ContextNavigator'],
  ['Route', (owner) => EXPO_ROUTE.test(owner)],
]);

const NAVIGATION_COLORS = ['primary', 'background', 'card', 'text', 'border', 'notification'];

/** A React Navigation theme, which its ThemeContext holds; an app's ThemeContext usually holds something else. */
function isNavigationTheme(value: Record<string, unknown>): boolean {
  const colors = value.colors as Record<string, unknown> | null | undefined;
  return typeof value.dark === 'boolean' && colors != null && NAVIGATION_COLORS.every((key) => typeof colors[key] === 'string');
}

/**
 * Expo Router's layouts (Stack, Tabs, Drawer…) carry `Screen` and `Protected` as statics, and some are anonymous
 * arrow functions, so the name of the app's layout that renders them would be taken for theirs.
 */
function ownedByExpoRouterLayout(fiber: Fiber): boolean {
  const owner = fiber._debugOwner as Fiber | null | undefined;
  if (owner == null || !('tag' in owner)) return false;
  for (let type = owner.elementType ?? owner.type, depth = 0; type != null && depth < 3; depth++) {
    if (typeof type.Screen === 'function' && typeof type.Protected === 'function') return true;
    if (typeof type !== 'object') return false;
    type = type.render ?? type.type;
  }
  return false;
}

/** The name of the component that rendered the owner: one step past `ownerName(fiber, true)`. */
function ownerOfOwnerName(fiber: Fiber): string | undefined {
  for (let owner = fiber._debugOwner as Fiber | null | undefined, hops = 0; owner != null && 'tag' in owner && hops < 20; hops++) {
    if (componentName(owner) !== undefined) return ownerName(owner, true);
    owner = owner._debugOwner as Fiber | null | undefined;
  }
  return undefined;
}

/**
 * The library a context comes from, or undefined for the app's own. Runs once per store. Only the owner counts, not
 * a component above: an app's provider passed to `root.render()` inside a library's has no owner.
 */
function vendorOf(fiber: Fiber, context: object, value: unknown): string | undefined {
  try {
    const redux = (globalThis as Record<symbol, unknown>)[Symbol.for('react-redux-context')];
    if (redux instanceof Map) for (const known of redux.values()) if (known === context) return 'react-redux';
    const navigation = (globalThis as Record<string, unknown>)[REACT_NAVIGATION_CONTEXTS];
    if (navigation instanceof Map) for (const known of navigation.values()) if (known === context) return 'React Navigation';
    // Bundlers number names they had to rename, e.g. `SWRConfig$1`.
    const plain = (text: string | undefined) => text?.replace(/(?:\$|_)\d+$/, '');
    const name = plain(contextName(context));
    if (value !== null && typeof value === 'object') {
      const v = value as Record<string, unknown>;
      if (typeof v.getQueryCache === 'function' && typeof v.getMutationCache === 'function') return 'TanStack Query';
      const cache = v.cache as Record<string, unknown> | null | undefined;
      if (typeof v.mutate === 'function' && cache != null && typeof cache.get === 'function' && typeof cache.set === 'function') {
        return 'SWR';
      }
      if (name === 'ThemeContext' && isNavigationTheme(v)) return 'React Navigation';
    }
    if (ownedByExpoRouterLayout(fiber)) return 'Expo Router';
    const owner = plain(ownerName(fiber, true));
    if (owner === undefined) return LIBRARY_CONTEXTS.get(name ?? '') ?? sourcePackage(fiber);
    const byOwner = LIBRARY_COMPONENTS_BY_OWNER.get(owner);
    const byName =
      LIBRARY_CONTEXTS.get(name ?? '') ??
      LIBRARY_COMPONENTS.get(owner) ??
      (EXPO_ROUTE.test(owner) || (byOwner !== undefined && byOwner(plain(ownerOfOwnerName(fiber)) ?? '')) ? 'Expo Router' : undefined);
    return byName ?? sourcePackage(fiber);
  } catch {
    return undefined;
  }
}

/**
 * The package whose code created the provider element, from where React says it was created. Web only: React
 * Native's stacks name the bundle rather than files.
 */
function sourcePackage(fiber: Fiber): string | undefined {
  let path: string | undefined;
  const source = fiber._debugSource as { fileName?: unknown } | null | undefined;
  if (typeof source?.fileName === 'string') {
    path = source.fileName;
  } else {
      // React Native's frames name the bundle, never a file: not worth formatting the stack for.
    if (typeof navigator === 'object' && navigator?.product === 'ReactNative') return undefined;
    const stack = (fiber._debugStack as { stack?: unknown } | null | undefined)?.stack;
    if (typeof stack !== 'string' || stack.includes('UnknownOwner')) return undefined;
    // The first frame is React's jsxDEV or createElement; the next is the code that created the element.
    const frame = stack.split('\n').filter((line) => /:\d+:\d+\)?\s*$/.test(line))[1];
    path = frame && /((?:[a-z][\w+.-]*:\/\/|\/)[^\s()]+?)(?::\d+){1,2}\)?\s*$/i.exec(frame)?.[1]?.replace(/[?#].*$/, '');
  }
  if (path === undefined) return undefined;
  // Turbopack names chunks after the path they hold, with underscores for slashes.
  if (/\/node_modules_[^/]*$/.test(path)) return 'a dependency';
  const at = path.lastIndexOf('node_modules/');
  if (at < 0) return undefined;
  const rest = path.slice(at + 'node_modules/'.length);
  // Vite serves dependencies as `.vite/deps/<name>.js`, with `@scope_name` for scoped ones.
  const vite = /^\.vite\/deps\/([^/]+?)\.js$/.exec(rest)?.[1];
  if (vite !== undefined) return vite.startsWith('chunk-') ? 'a dependency' : vite.replace(/^(@[^_]+)_/, '$1/');
  const parts = rest.split('/');
  return (parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]) || 'a dependency';
}
