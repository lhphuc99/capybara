// @vitest-environment happy-dom
import vm from 'node:vm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StateStoreInfo } from '@capybara-devtools/protocol';
import { CLIENT_GLOBAL, serialize, statePlugin, type PluginContext, type StatePluginOptions } from '../src/index.js';
import { walkProviders, type Fiber, type FiberRoot } from '../src/plugins/state/fibers.js';
import { installReactHook, type ReactHook } from '../src/plugins/state/react-hook.js';
import { REGISTRY_GLOBAL } from '../src/plugins/state/registry.js';

type Recorded = { kind: string; payload: any };
type ReactModule = typeof import('react');
type Root = import('react-dom/client').Root;

const HOOK = '__REACT_DEVTOOLS_GLOBAL_HOOK__';
const scope = globalThis as Record<string, any>;

// ---------------------------------------------------------------------------
// Fake fibers, shaped like React 18's: providers render `context.Provider`, which points back to the context.
// ---------------------------------------------------------------------------

interface FakeFiber extends Fiber {
  name?: string;
}

function fiber(tag: number, type: unknown, props: unknown = {}, children: FakeFiber[] = []): FakeFiber {
  const node: FakeFiber = {
    tag,
    type,
    return: null,
    child: null,
    sibling: null,
    alternate: null,
    memoizedProps: props,
    _debugOwner: null,
  };
  let previous: FakeFiber | null = null;
  for (const child of children) {
    child.return = node;
    if (previous) previous.sibling = child;
    else node.child = child;
    previous = child;
  }
  return node;
}

const legacyContext = (displayName?: string) => {
  const context: Record<string, unknown> = { $$typeof: Symbol.for('react.context'), _currentValue: null };
  context.Provider = { $$typeof: Symbol.for('react.provider'), _context: context };
  if (displayName) context.displayName = displayName;
  return context as { Provider: object; displayName?: string };
};
const provider = (context: { Provider: object }, value: unknown, children: FakeFiber[] = []) =>
  fiber(10, context.Provider, { value, children: null }, children);
const component = (fn: (...args: any[]) => unknown, children: FakeFiber[] = []) => fiber(0, fn, {}, children);
const host = (children: FakeFiber[] = []) => fiber(5, 'div', {}, children);
const rootOf = (child: FakeFiber): FiberRoot => {
  const hostRoot = fiber(3, null, null, [child]);
  hostRoot.memoizedState = { element: {} };
  return { current: hostRoot };
};

/**
 * The tree's other copy, as React makes on a commit; `replace` swaps in fibers that rendered again. React keeps the
 * root object and points its `current` at the new HostRoot.
 */
function commitAgain(root: FiberRoot, replace: (old: FakeFiber) => FakeFiber | undefined = () => undefined): FiberRoot {
  const copy = (old: FakeFiber, parent: FakeFiber | null): FakeFiber => {
    const swapped = replace(old);
    if (swapped) {
      swapped.return = parent;
      return swapped;
    }
    const next: FakeFiber = { ...old, alternate: old, return: parent, child: null, sibling: null };
    old.alternate = next;
    let previous: FakeFiber | null = null;
    for (let child = old.child; child; child = child.sibling) {
      const made = copy(child as FakeFiber, next);
      if (previous) previous.sibling = made;
      else next.child = made;
      previous = made;
    }
    return next;
  };
  root.current = copy(root.current as FakeFiber, null);
  return root;
}

describe('walkProviders', () => {
  it('finds React 18 providers through `type._context`, and reports each once', () => {
    const Theme = legacyContext('Theme');
    const Auth = legacyContext();
    const root = rootOf(component(function App() {}, [provider(Theme, 'dark', [host([provider(Auth, { user: 'ann' })])])]));
    const seen = new WeakMap<object, unknown>();
    const first = walkProviders(root, seen);
    expect(first.providers.map((hit) => [hit.context, hit.value, hit.first])).toEqual([
      [Theme, 'dark', true],
      [Auth, { user: 'ann' }, true],
    ]);
    expect(first.visited).toBe(5);
    expect(walkProviders(root, seen).providers).toEqual([]);
  });

  it('after a commit, goes only into subtrees whose children changed, and reports changed values', () => {
    const Theme = legacyContext('Theme');
    const Row = legacyContext('Row');
    const rows = Array.from({ length: 50 }, (_, i) => provider(Row, i, [host([host(), host()])]));
    const list = host(rows);
    const themed = provider(Theme, 'dark', [host([host()])]);
    const first = rootOf(component(function App() {}, [host([list, themed])]));
    const seen = new WeakMap<object, unknown>();
    expect(walkProviders(first, seen).providers).toHaveLength(51);

    // The list bailed out and keeps its children; only the themed subtree rendered again, with a new value.
    const second = commitAgain(first, (old) => {
      if (old !== list) return undefined;
      const kept: FakeFiber = { ...list, alternate: list, child: list.child };
      list.alternate = kept;
      return kept;
    });
    const themedNow = second.current.child!.child!.child!.sibling!;
    themedNow.memoizedProps = { value: 'light' };
    const visits: number[] = [];
    const result = walkProviders(second, seen, { changed: true, visit: (node) => visits.push(node.tag) });
    expect(result.providers.map((hit) => [hit.value, hit.first])).toEqual([['light', false]]);
    // HostRoot, App, the div, the list (not its 50 rows), the provider and its two divs.
    expect(result.visited).toBe(7);
    expect(visits).toEqual([3, 0, 5, 5, 10, 5, 5]);
  });

  it('notices removals in a commit', () => {
    const root = rootOf(component(function App() {}, [host()]));
    const seen = new WeakMap<object, unknown>();
    walkProviders(root, seen);
    const next = commitAgain(root);
    next.current.child!.deletions = [host()];
    expect(walkProviders(next, seen, { changed: true }).removed).toBe(true);
  });

  it('stops at its budget or limit and goes on from where it stopped, visiting each fiber once', () => {
    const Row = legacyContext('Row');
    const root = rootOf(host(Array.from({ length: 30 }, (_, i) => provider(Row, i, [host([host()])]))));
    const seen = new WeakMap<object, unknown>();
    let clock = 0;
    const values: unknown[] = [];
    let visited = 0;
    let calls = 0;
    let next = null;
    do {
      const result = walkProviders(root, seen, { from: next, limit: 4, budget: 1_000, now: () => clock++ });
      values.push(...result.providers.map((hit) => hit.value));
      visited += result.visited;
      next = result.next;
      calls++;
    } while (next);
    expect(values).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(visited).toBe(1 + 1 + 30 * 3);
    expect(calls).toBe(8);
  });

  it('works from its source alone, as the Metro bridge will run it inside apps', () => {
    const app = vm.createContext({});
    const inApp = vm.runInContext(`(${walkProviders.toString()})`, app) as typeof walkProviders;
    const tree = vm.runInContext(
      `(() => {
        const context = { displayName: 'Session' };
        context.Provider = { _context: context };
        const leaf = { tag: 5, type: 'div', child: null, sibling: null, return: null, alternate: null, memoizedProps: {} };
        const host = { tag: 10, type: context.Provider, child: leaf, sibling: null, return: null, alternate: null, memoizedProps: { value: { user: 'ann' } } };
        const top = { tag: 3, type: null, child: host, sibling: null, return: null, alternate: null, memoizedProps: null };
        return { root: { current: top }, seen: new WeakMap(), context };
      })()`,
      app,
    ) as { root: FiberRoot; seen: WeakMap<object, unknown>; context: object };
    // No `performance` in there: a budget runs on Date.now.
    const result = inApp(tree.root, tree.seen, { budget: 50 });
    expect(result.visited).toBe(3);
    expect(result.next).toBeNull();
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]!.context).toBe(tree.context);
    expect(JSON.stringify(result.providers[0]!.value)).toBe('{"user":"ann"}');
  });
});

// ---------------------------------------------------------------------------
// The global hook
// ---------------------------------------------------------------------------

describe('installReactHook', () => {
  let saved: PropertyDescriptor | undefined;
  beforeEach(() => {
    saved = Object.getOwnPropertyDescriptor(window, HOOK);
    delete scope[HOOK];
  });
  afterEach(() => {
    delete scope[HOOK];
    if (saved) Object.defineProperty(window, HOOK, saved);
  });

  it('installs a minimal hook when there is none, for React to inject into', () => {
    const roots: unknown[] = [];
    const { hook, undo } = installReactHook((root) => roots.push(root));
    const installed = scope[HOOK] as Record<string, any>;
    expect(installed).toBe(hook);
    expect(installed.supportsFiber).toBe(true);
    expect(installed.isDisabled).toBeUndefined();
    for (const method of ['inject', 'getFiberRoots', 'onCommitFiberRoot', 'onCommitFiberUnmount', 'onPostCommitFiberRoot']) {
      expect(typeof installed[method]).toBe('function');
    }
    const renderer = { version: '19.2.3' };
    const id = installed.inject(renderer);
    expect(installed.renderers.get(id)).toBe(renderer);
    const root = rootOf(host());
    installed.onCommitFiberRoot(id, root, 0, false);
    expect(roots).toEqual([root]);
    expect([...installed.getFiberRoots(id)]).toEqual([root]);
    // An unmounted root has no element.
    root.current.memoizedState = { element: null };
    installed.onCommitFiberRoot(id, root, 0, false);
    expect(installed.getFiberRoots(id).size).toBe(0);
    undo();
    installed.onCommitFiberRoot(id, root, 0, false);
    expect(roots).toHaveLength(2);
  });

  it('wraps the onCommitFiberRoot of the hook it finds, calling the original first, and puts it back', () => {
    const order: string[] = [];
    const original = vi.fn(function (this: unknown) {
      order.push('original');
      return 'result';
    });
    const hook = { renderers: new Map(), supportsFiber: true, inject: () => 1, onCommitFiberRoot: original };
    scope[HOOK] = hook;
    const { undo } = installReactHook(() => order.push('ours'));
    expect(scope[HOOK]).toBe(hook);
    const root = rootOf(host());
    expect(hook.onCommitFiberRoot.call(hook, 1, root, 3, false)).toBe('result');
    expect(order).toEqual(['original', 'ours']);
    expect(original).toHaveBeenCalledWith(1, root, 3, false);
    expect(original.mock.contexts[0]).toBe(hook);
    undo();
    expect(hook.onCommitFiberRoot).toBe(original);
  });

  it('still runs after an original that throws, which React then reports as before', () => {
    const seen: unknown[] = [];
    const hook = {
      onCommitFiberRoot: () => {
        throw new Error('devtools broke');
      },
    };
    scope[HOOK] = hook;
    installReactHook((root) => seen.push(root));
    expect(() => hook.onCommitFiberRoot()).toThrow('devtools broke');
    expect(seen).toHaveLength(1);
  });

  it('leaves a wrapper someone wrapped since in place, passing calls on', () => {
    const calls: string[] = [];
    const hook: Record<string, any> = { onCommitFiberRoot: () => calls.push('original') };
    scope[HOOK] = hook;
    const { undo } = installReactHook(() => calls.push('ours'));
    const ours = hook.onCommitFiberRoot;
    // e.g. React Refresh, loaded after the SDK
    hook.onCommitFiberRoot = (...args: unknown[]) => {
      calls.push('refresh');
      return ours(...args);
    };
    const refresh = hook.onCommitFiberRoot;
    undo();
    expect(hook.onCommitFiberRoot).toBe(refresh);
    hook.onCommitFiberRoot(1, rootOf(host()));
    expect(calls).toEqual(['refresh', 'original']);
  });

  it('keeps away from a hook that opted out of DevTools', () => {
    const hook = { isDisabled: true, onCommitFiberRoot: vi.fn() };
    scope[HOOK] = hook;
    const onCommit = vi.fn();
    const { hook: wrapped } = installReactHook(onCommit);
    expect(wrapped).toBeUndefined();
    expect(Object.keys(hook)).toEqual(['isDisabled', 'onCommitFiberRoot']);
    expect(hook.isDisabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stores, with React 19 rendering into happy-dom
// ---------------------------------------------------------------------------

const refreshOnCommit = vi.fn();
/** Stands in for React Refresh's minimal hook, which Vite installs before any app code. */
const refresh: Record<string, unknown> = {
  renderers: new Map(),
  supportsFiber: true,
  inject: () => 7,
  onScheduleFiberRoot() {},
  onCommitFiberRoot: refreshOnCommit,
  onCommitFiberUnmount() {},
};
let React: ReactModule;
let createRoot: typeof import('react-dom/client').createRoot;
let h: ReactModule['createElement'];
let act: ReactModule['act'];
const teardowns: Array<() => void> = [];

beforeAll(async () => {
  scope[HOOK] = refresh;
  scope.IS_REACT_ACT_ENVIRONMENT = true;
  // After the hook, as in an app: react-dom injects into whatever hook exists while it loads.
  React = await import('react');
  ({ createRoot } = await import('react-dom/client'));
  h = React.createElement;
  act = React.act;
});

function harness(options: StatePluginOptions = {}) {
  const events: Recorded[] = [];
  const ctx: PluginContext = { emit: (kind, payload) => events.push({ kind, payload }), serialize, console };
  const plugin = statePlugin(options);
  const teardown = plugin.setup!(ctx) as () => void;
  teardowns.push(teardown);
  const of = (kind: string) => events.filter((e) => e.kind === kind).map((e) => e.payload);
  const stores = () => {
    const latest = new Map<string, StateStoreInfo>();
    for (const { store } of of('state.store')) latest.set(store.id, store);
    return [...latest.values()];
  };
  const live = () => stores().filter((store) => !store.disposed);
  const changes = (id: string) => of('state.change').filter((change) => change.store === id);
  return { events, of, stores, live, changes, commands: plugin.commands!, teardown };
}

function mount(element: unknown): Root {
  const root = createRoot(document.createElement('div'));
  act(() => root.render(element as any));
  teardowns.push(() => act(() => root.unmount()));
  return root;
}

describe('React Context stores', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(CLIENT_GLOBAL, { connected: true });
    refreshOnCommit.mockReset();
  });
  afterEach(() => {
    for (const teardown of teardowns.splice(0).reverse()) teardown();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete scope[REGISTRY_GLOBAL];
    delete scope[Symbol.for('react-redux-context')];
    delete scope.__react_navigation__elements_contexts;
  });

  it('names each store by displayName, then the owner component, then a number', () => {
    const { live } = harness();
    const Auth = React.createContext<unknown>(null);
    Auth.displayName = 'AuthContext';
    const Theme = React.createContext('light');
    const Bare = React.createContext(0);
    function ThemeProvider({ children }: { children?: unknown }) {
      return h(Theme.Provider, { value: 'dark' }, children as any);
    }
    mount(h(Bare.Provider, { value: 1 }, h(Auth.Provider, { value: { user: null } }, h(ThemeProvider, null, h('p')))));
    expect(live().map((store) => store.label)).toEqual(['Context #1', 'AuthContext', 'ThemeProvider']);
    expect(live()[0]).toEqual({ id: 'context:1', library: 'context', label: 'Context #1', via: 'fiber', actions: false });
  });

  it('drops the suffix bundlers add to clashing names', () => {
    const { live } = harness();
    const Session = React.createContext<unknown>(null);
    const SessionProvider = ({ children }: { children?: unknown }) => h(Session.Provider, { value: { user: 'ann' } }, children as any);
    Object.defineProperty(SessionProvider, 'name', { value: 'SessionProvider$1' });
    mount(h(SessionProvider, null, h('p')));
    expect(live().map((store) => store.label)).toEqual(['SessionProvider']);
  });

  it('records each change of value with a diff, and nothing while the value keeps its reference', () => {
    const { live, changes, commands } = harness();
    const Session = React.createContext<{ user: string | null; theme: string }>({ user: null, theme: 'light' });
    Session.displayName = 'Session';
    let setUser!: (user: string | null) => void;
    let bump!: () => void;
    function App() {
      const [user, set] = React.useState<string | null>(null);
      const [, setCount] = React.useState(0);
      setUser = set;
      bump = () => setCount((count) => count + 1);
      const value = React.useMemo(() => ({ user, theme: 'light' }), [user]);
      return h(Session.Provider, { value }, h('p', null, user));
    }
    mount(h(App));
    const id = live()[0]!.id;
    expect(commands.get!({ store: id })).toMatchObject({ value: { user: null, theme: 'light' }, pending: false });

    act(() => setUser('ann'));
    vi.advanceTimersByTime(100);
    expect(changes(id)).toEqual([{ store: id, rev: 1, cause: 'set', ops: [{ op: 'set', path: ['user'], value: 'ann', prev: null }] }]);
    act(() => bump());
    vi.advanceTimersByTime(100);
    expect(changes(id)).toHaveLength(1);
    expect(commands.get!({ store: id, path: ['user'] })).toMatchObject({ rev: 1, pending: false, value: 'ann' });
  });

  it('keeps calling the hook it found, before doing its own work', () => {
    const { of } = harness();
    const storesWhenCalled: number[] = [];
    refreshOnCommit.mockImplementation(() => storesWhenCalled.push(of('state.store').length));
    const Flag = React.createContext(false);
    mount(h(Flag.Provider, { value: true }, h('p')));
    expect(refreshOnCommit).toHaveBeenCalledTimes(1);
    expect(refreshOnCommit.mock.calls[0]![0]).toBe(7);
    expect(refreshOnCommit.mock.contexts[0]).toBe(refresh);
    expect(storesWhenCalled).toEqual([0]);
    expect(of('state.store')).toHaveLength(1);
  });

  it('puts the hook back as it was when the client stops', () => {
    const { teardown } = harness();
    expect(scope[HOOK]).toBe(refresh);
    expect(refresh.onCommitFiberRoot).not.toBe(refreshOnCommit);
    teardown();
    expect(scope[HOOK]).toBe(refresh);
    expect(refresh.onCommitFiberRoot).toBe(refreshOnCommit);
    expect('isDisabled' in refresh).toBe(false);
  });

  it('makes one store of the providers of a context under one name, counting them', () => {
    const { live, of, commands } = harness();
    const Row = React.createContext(0);
    Row.displayName = 'Row';
    let setRows!: (rows: number) => void;
    function List() {
      const [rows, set] = React.useState(3);
      setRows = set;
      return h('ul', null, Array.from({ length: rows }, (_, i) => h(Row.Provider, { key: i, value: i }, h('li'))));
    }
    mount(h(List));
    expect(live()).toEqual([expect.objectContaining({ label: 'Row', instances: 3 })]);
    const id = live()[0]!.id;
    // Each provider's value under its React key.
    expect(commands.get!({ store: id })).toMatchObject({ value: { 0: 0, 1: 1, 2: 2 } });

    act(() => setRows(5));
    vi.advanceTimersByTime(300);
    expect(live()).toEqual([expect.objectContaining({ label: 'Row', instances: 5 })]);
    expect(commands.stores!(undefined)).toEqual([expect.objectContaining({ label: 'Row', instances: 5 })]);
    expect(of('state.change').at(-1)).toMatchObject({ ops: [{ op: 'add', path: ['3'] }, { op: 'add', path: ['4'] }] });

    act(() => setRows(1));
    vi.advanceTimersByTime(2_000);
    expect(live()[0]).not.toHaveProperty('instances');
    expect(of('state.store').filter((e) => e.store.label === 'Row')).toHaveLength(3);
    // Down to one provider, the state is its value again.
    expect(commands.get!({ store: id })).toMatchObject({ value: 0, pending: false });
  });

  it('keeps each provider of a list under its key, recording once per commit', () => {
    const { live, changes, commands } = harness();
    const Row = React.createContext<{ name: string; price: number } | null>(null);
    Row.displayName = 'Row';
    let setPrices!: (prices: number[]) => void;
    let rerender!: () => void;
    function List() {
      const [prices, set] = React.useState([3, 4, 5]);
      const [, setCount] = React.useState(0);
      setPrices = set;
      rerender = () => setCount((n) => n + 1);
      // A new value object for every row on every render, as lists often do.
      return h('ul', null, ['tea', 'mochi', 'yuzu'].map((name, i) => h(Row.Provider, { key: name, value: { name, price: prices[i]! } }, h('li'))));
    }
    mount(h(List));
    const id = live()[0]!.id;
    expect(commands.get!({ store: id, path: ['mochi'] })).toMatchObject({ value: { name: 'mochi', price: 4 } });
    act(() => rerender());
    vi.advanceTimersByTime(100);
    expect(changes(id)).toEqual([]);

    act(() => setPrices([3, 6, 5]));
    vi.advanceTimersByTime(100);
    expect(changes(id).map((change) => change.ops)).toEqual([[{ op: 'set', path: ['mochi', 'price'], value: 6, prev: 4 }]]);
  });

  it('numbers providers without a key, and keeps only the latest value past 20 of them', () => {
    const { live, changes, commands } = harness();
    const Theme = React.createContext('light');
    Theme.displayName = 'Theme';
    const Cell = React.createContext(0);
    Cell.displayName = 'Cell';
    let setCells!: (values: number[]) => void;
    function Grid() {
      const [values, set] = React.useState(Array.from({ length: 21 }, (_, i) => i));
      setCells = set;
      return h('table', null, values.map((value, i) => h(Cell.Provider, { key: i, value }, h('td'))));
    }
    mount(h(Theme.Provider, { value: 'dark' }, h('main', null, h(Theme.Provider, { value: 'light' }, h(Grid)))));
    const [theme, cell] = live();
    expect(commands.get!({ store: theme!.id })).toMatchObject({ value: { '#1': 'dark', '#2': 'light' } });
    expect(cell).toMatchObject({ label: 'Cell', instances: 21 });

    act(() => setCells(Array.from({ length: 21 }, (_, i) => (i === 7 ? 70 : i))));
    vi.advanceTimersByTime(100);
    expect(changes(cell!.id)).toEqual([{ store: cell!.id, rev: 1, cause: 'set', ops: [{ op: 'set', path: [], value: 70, prev: 0 }] }]);
  });

  it('marks a store disposed once its providers unmount', () => {
    const { stores } = harness();
    const Modal = React.createContext('closed');
    Modal.displayName = 'Modal';
    let setOpen!: (open: boolean) => void;
    function App() {
      const [open, set] = React.useState(true);
      setOpen = set;
      return h('main', null, open ? h(Modal.Provider, { value: 'open' }, h('dialog')) : null);
    }
    mount(h(App));
    expect(stores()).toEqual([expect.objectContaining({ label: 'Modal' })]);
    act(() => setOpen(false));
    expect(stores()[0]).not.toHaveProperty('disposed');
    vi.advanceTimersByTime(2_000);
    expect(stores()).toEqual([expect.objectContaining({ label: 'Modal', disposed: true })]);
  });

  it('skips subtrees that bailed out', () => {
    harness();
    const visits: number[] = [];
    const seen = new WeakMap<object, unknown>();
    const counting = scope[HOOK].onCommitFiberRoot;
    scope[HOOK].onCommitFiberRoot = function (this: unknown, id: number, root: FiberRoot, ...rest: unknown[]) {
      const result = counting.call(this, id, root, ...rest);
      visits.push(walkProviders(root, seen, { changed: visits.length > 0 }).visited);
      return result;
    };
    teardowns.push(() => {
      scope[HOOK].onCommitFiberRoot = counting;
    });
    const Big = React.memo(function Big() {
      return h('ul', null, Array.from({ length: 300 }, (_, i) => h('li', { key: i }, h('span', null, i))));
    });
    let bump!: () => void;
    function Counter() {
      const [count, setCount] = React.useState(0);
      bump = () => setCount((n) => n + 1);
      return h('b', null, count);
    }
    mount(h('div', null, h(Big), h(Counter)));
    act(() => bump());
    expect(visits[0]).toBeGreaterThan(600);
    // HostRoot, the div, Big (not its 600 fibers below), Counter and its <b>.
    expect(visits[1]).toBe(5);
  });

  it('marks the contexts of libraries, which the UI hides until asked', () => {
    const { live } = harness();
    const Redux = React.createContext<unknown>(null);
    scope[Symbol.for('react-redux-context')] = new Map([[React.createContext, Redux]]);
    const Query = React.createContext<unknown>(undefined);
    const Swr = React.createContext<unknown>({});
    const Text = React.createContext(false);
    Text.displayName = 'TextAncestorContext';
    const Insets = React.createContext<unknown>(null);
    const App = React.createContext('mine');
    App.displayName = 'App';
    const client = { getQueryCache() {}, getMutationCache() {} };
    const swr = { cache: new Map(), mutate() {} };
    function SafeAreaProvider({ children }: { children?: unknown }) {
      return h(Insets.Provider, { value: { top: 0 } }, children as any);
    }
    mount(
      h(Redux.Provider, { value: { store: {} } },
        h(Query.Provider, { value: client },
          h(Swr.Provider, { value: swr },
            h(Text.Provider, { value: true },
              h(SafeAreaProvider, null, h(App.Provider, { value: 'mine' }, h('p'))))))),
    );
    expect(live().map((store) => [store.label, store.vendor])).toEqual([
      ['Context #1', 'react-redux'],
      ['Context #2', 'TanStack Query'],
      ['Context #3', 'SWR'],
      ['TextAncestorContext', 'React Native'],
      ['SafeAreaProvider', 'react-native-safe-area-context'],
      ['App', undefined],
    ]);
  });

  it("marks Expo Router's and React Navigation's contexts, which React Native can't tell by file", () => {
    const { live } = harness();
    type Props = { children?: any };
    const Queue = React.createContext<unknown>(null);
    const RouteState = React.createContext<unknown>(null);
    const Params = React.createContext<unknown>({});
    const Slot = React.createContext<unknown>(null);
    const Header = React.createContext<unknown>(0);
    scope.__react_navigation__elements_contexts = new Map([['HeaderTitleContext', Header]]);
    const NavigationTheme = React.createContext<unknown>(null);
    NavigationTheme.displayName = 'ThemeContext';
    const AppTheme = React.createContext<unknown>(null);
    AppTheme.displayName = 'ThemeContext';
    const Mine = React.createContext<unknown>(null);
    const colors = { primary: '#007aff', background: '#fff', card: '#fff', text: '#000', border: '#ccc', notification: '#f00' };

    function RoutingQueueProvider({ children }: Props) {
      return h(Queue.Provider, { value: [] }, children);
    }
    // Expo Router's Route, which each route's component renders, provides the route's params.
    function Route({ children }: Props) {
      return h(Params.Provider, { value: {} }, children);
    }
    function BaseRoute({ children }: Props) {
      return h(RouteState.Provider, { value: 'index' }, h(Route, null, children));
    }
    BaseRoute.displayName = 'Route(index)';
    function Content({ children }: Props) {
      return h(Slot.Provider, { value: 'slot' }, children);
    }
    function ContextNavigator({ children }: Props) {
      return h(Content, null, children);
    }
    // The app's own Content and Route: something else renders them.
    const AppContent = function Content({ children }: Props) {
      return h(Mine.Provider, { value: 'mine' }, children);
    };
    const AppRoute = function Route({ children }: Props) {
      return h(Mine.Provider, { value: 'route' }, children);
    };
    // Expo Router's Stack: an arrow function, so nameless, with the screens as statics.
    const Within = React.createContext(false);
    const Stack = Object.assign(({ children }: Props) => h(Within.Provider, { value: true }, children), {
      Screen: () => null,
      Protected: () => null,
    });
    function HomeScreen() {
      return h(Stack, null, h(AppContent, null, h(AppRoute, null, h('p'))));
    }
    mount(
      h(RoutingQueueProvider, null,
        h(ContextNavigator, null,
          h(BaseRoute, null,
            h(Header.Provider, { value: 56 },
              h(NavigationTheme.Provider, { value: { dark: false, colors, fonts: {} } },
                h(AppTheme.Provider, { value: { mode: 'dark' } }, h(HomeScreen))))))),
    );
    expect(live().map((store) => [store.label, store.vendor])).toEqual([
      ['RoutingQueueProvider', 'Expo Router'],
      ['Content', 'Expo Router'],
      ['Route(index)', 'Expo Router'],
      ['Route', 'Expo Router'],
      ['Route #2', 'React Navigation'],
      ['ThemeContext', 'React Navigation'],
      ['ThemeContext #2', undefined],
      ['HomeScreen', 'Expo Router'],
      ['Content #2', undefined],
      ['Route #3', undefined],
    ]);
  });

  it('gives a second context with the same name a label of its own', () => {
    const { live } = harness();
    const First = React.createContext(1);
    const Second = React.createContext(2);
    function Providers({ children }: { children?: unknown }) {
      return h(First.Provider, { value: 1 }, h(Second.Provider, { value: 2 }, children as any));
    }
    mount(h(Providers, null, h('p')));
    expect(live().map((store) => store.label)).toEqual(['Providers', 'Providers #2']);
  });

  it('takes the store over when hot reload makes a new context with the same name', () => {
    const { stores, live } = harness();
    let version = 1;
    const contexts = new Map<number, ReturnType<typeof React.createContext<number>>>();
    const contextOf = (n: number) => {
      if (!contexts.has(n)) {
        const made = React.createContext(0);
        made.displayName = 'Cart';
        contexts.set(n, made);
      }
      return contexts.get(n)!;
    };
    let reload!: () => void;
    function App() {
      const [, setCount] = React.useState(0);
      reload = () => {
        version++;
        setCount((n) => n + 1);
      };
      return h(contextOf(version).Provider, { value: version }, h('p'));
    }
    mount(h(App));
    act(() => reload());
    expect(stores().map((store) => [store.id, store.label, store.disposed ?? false])).toEqual([
      ['context:1', 'Cart', true],
      ['context:2', 'Cart', false],
    ]);
    expect(live()).toHaveLength(1);
  });

  it('does nothing with `context: false`', () => {
    const { of } = harness({ context: false });
    const Flag = React.createContext(false);
    mount(h(Flag.Provider, { value: true }, h('p')));
    expect(of('state.store')).toEqual([]);
    expect(refresh.onCommitFiberRoot).toBe(refreshOnCommit);
  });
});

// ---------------------------------------------------------------------------
// Fake fibers through the hook: where React says an element was created, and React 18's shape
// ---------------------------------------------------------------------------

describe('React Context stores from fake fibers', () => {
  let saved: PropertyDescriptor | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(CLIENT_GLOBAL, { connected: true });
    saved = Object.getOwnPropertyDescriptor(window, HOOK);
    delete scope[HOOK];
  });
  afterEach(() => {
    for (const teardown of teardowns.splice(0).reverse()) teardown();
    delete scope[HOOK];
    if (saved) Object.defineProperty(window, HOOK, saved);
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete scope[REGISTRY_GLOBAL];
  });

  const commit = (root: FiberRoot) => (scope[HOOK] as ReactHook & { onCommitFiberRoot: (...args: unknown[]) => void }).onCommitFiberRoot(1, root, 0, false);
  const stack = (file: string) => ({
    stack: `Error: react-stack-top-frame\n    at jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1a2b:250:30)\n    at Owner (${file}:12:34)\n    at react_stack_bottom_frame (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=1a2b:1:1)`,
  });

  it('takes the package that created the provider from React 19 stacks and React 18 sources', () => {
    const { live } = harness();
    const providers = [
      ['http://localhost:5173/node_modules/.vite/deps/@tanstack_react-query.js?v=1a2b', 'Vite scoped'],
      ['http://localhost:5173/node_modules/.vite/deps/react-hook-form.js?v=1a2b', 'Vite'],
      ['webpack-internal:///(app-pages-browser)/./node_modules/next/dist/client/components/layout-router.js', 'webpack'],
      ['http://localhost:3000/_next/static/chunks/node_modules_next_dist_client_components_1a2b._.js', 'Turbopack'],
      ['http://localhost:5173/src/App.tsx?t=123', 'app'],
    ].map(([file, name]) => {
      const context = legacyContext(name);
      const node = provider(context, name);
      node._debugStack = stack(file!);
      return node;
    });
    const legacy = provider(legacyContext('React 18'), 0);
    legacy._debugSource = { fileName: '/Users/me/app/node_modules/@scope/kit/dist/index.js', lineNumber: 1 };
    const fiberRoot = rootOf(host([...providers, legacy]));
    (fiberRoot.current as FakeFiber)._debugOwner = null;
    commit(fiberRoot);
    expect(live().map((store) => [store.label, store.vendor])).toEqual([
      ['Vite scoped', '@tanstack/react-query'],
      ['Vite', 'react-hook-form'],
      ['webpack', 'next'],
      ['Turbopack', 'a dependency'],
      ['app', undefined],
      ['React 18', '@scope/kit'],
    ]);
  });

  it('follows React 18 trees across commits: changes, new providers, and unmounts', () => {
    const { live, stores, changes } = harness();
    const Cart = legacyContext('Cart');
    const Toast = legacyContext('Toast');
    const cart = provider(Cart, { items: [] }, [host()]);
    const first = rootOf(component(function App() {}, [host([cart])]));
    commit(first);
    const id = live()[0]!.id;

    const toast = provider(Toast, 'saved', [host()]);
    const second = commitAgain(first, (old) => {
      if (old !== cart) return undefined;
      const next = provider(Cart, { items: ['milk'] }, [host()]);
      next.alternate = old;
      old.alternate = next;
      next.sibling = toast;
      return next;
    });
    toast.return = second.current.child!.child;
    commit(second);
    vi.advanceTimersByTime(100);
    expect(changes(id)).toEqual([
      { store: id, rev: 1, cause: 'set', ops: [{ op: 'add', path: ['items', 0], value: 'milk' }] },
    ]);
    expect(live().map((store) => store.label)).toEqual(['Cart', 'Toast']);

    // React cuts a removed subtree loose: its top no longer has a parent.
    const third = commitAgain(second);
    const div = third.current.child!.child!;
    div.deletions = [toast];
    const cartNow = div.child!;
    cartNow.sibling = null;
    toast.return = null;
    toast.alternate = null;
    commit(third);
    vi.advanceTimersByTime(2_000);
    expect(stores().map((store) => [store.label, store.disposed ?? false])).toEqual([
      ['Cart', false],
      ['Toast', true],
    ]);
  });

  it('ignores production builds of React, whose fibers have no debug fields', () => {
    const { of } = harness();
    const root = rootOf(provider(legacyContext('Prod'), 1));
    delete (root.current as FakeFiber)._debugOwner;
    commit(root);
    expect(of('state.store')).toEqual([]);
  });
});
