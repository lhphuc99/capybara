import type { FiberRoot } from './fibers.js';

const HOOK = '__REACT_DEVTOOLS_GLOBAL_HOOK__';

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
