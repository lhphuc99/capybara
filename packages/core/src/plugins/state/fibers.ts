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

/** Fiber tag of a root. */
export const HOST_ROOT = 3;
