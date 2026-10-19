import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { createStateEngine, diffState, readPath, type DiffLimits } from '../src/plugins/state/engine.js';
import type { StateSink, StoreDriver } from '../src/plugins/state/index.js';
import { serialize } from '../src/serialize.js';

const limits: DiffLimits = {
  maxOps: 100,
  maxDepth: 12,
  maxNodes: 5_000,
  preview: { maxDepth: 3, maxKeys: 20, maxItems: 20, maxString: 200, maxNodes: 200 },
};
const diff = (prev: unknown, next: unknown, extra: Partial<DiffLimits> = {}) =>
  diffState(prev, next, { ...limits, ...extra }, serialize);

describe('diffState', () => {
  it('finds nothing when the reference is the same', () => {
    const state = { a: { b: 1 } };
    expect(diff(state, state)).toEqual({ ops: [], opCount: 0 });
  });

  it('walks only into branches whose reference changed', () => {
    // Any trap would throw, and the diff would then report the whole state as replaced.
    const untouchable = new Proxy(
      {},
      {
        get: () => {
          throw new Error('read');
        },
        ownKeys: () => {
          throw new Error('keys');
        },
      },
    );
    const prev = { user: { name: 'Ann', age: 30 }, cache: untouchable };
    const next = { user: { name: 'Ann', age: 31 }, cache: untouchable };
    expect(diff(prev, next)).toEqual({ ops: [{ op: 'set', path: ['user', 'age'], value: 31, prev: 30 }], opCount: 1 });
  });

  it('compares arrays by index, adding and removing at the end', () => {
    expect(diff({ list: [1, 2, 3] }, { list: [1, 9, 3, 4] }).ops).toEqual([
      { op: 'set', path: ['list', 1], value: 9, prev: 2 },
      { op: 'add', path: ['list', 3], value: 4 },
    ]);
    expect(diff([1, 2, 3], [1]).ops).toEqual([
      { op: 'del', path: [1], prev: 2 },
      { op: 'del', path: [2], prev: 3 },
    ]);
  });

  it('reports keys added and removed', () => {
    expect(diff({ a: 1, gone: { x: 1 } }, { a: 1, fresh: 'new' }).ops).toEqual([
      { op: 'add', path: ['fresh'], value: 'new' },
      { op: 'del', path: ['gone'], prev: { x: 1 } },
    ]);
    expect(diff(undefined, { a: 1 }).ops).toEqual([{ op: 'set', path: [], value: { a: 1 }, prev: { $t: 'undefined' } }]);
  });

  it('treats Maps, Sets and class instances as leaves compared by reference', () => {
    class Point {
      x: number;
      constructor(x: number) {
        this.x = x;
      }
    }
    const tags = new Set(['x']);
    const prev = { byId: new Map([[1, 'a']]), tags, at: new Point(1) };
    const next = { byId: new Map([[1, 'a']]), tags, at: new Point(1) };
    const map = { $t: 'map', entries: [[1, 'a']], size: 1 };
    const point = { $t: 'object', name: 'Point', props: { x: 1 } };
    expect(diff(prev, next).ops).toEqual([
      { op: 'set', path: ['byId'], value: map, prev: map },
      { op: 'set', path: ['at'], value: point, prev: point },
    ]);
  });

  it('keeps the first 100 ops and counts the rest', () => {
    const prev = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`k${i}`, i]));
    const next = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`k${i}`, i + 1]));
    const { ops, opCount } = diff(prev, next);
    expect(ops).toHaveLength(100);
    expect(opCount).toBe(150);
  });

  it('replaces the subtree where the depth limit stops it', () => {
    const nest = (leaf: number) => {
      let value: unknown = leaf;
      for (let i = 0; i < 15; i++) value = { d: value };
      return value;
    };
    const { ops } = diff(nest(1), nest(2));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'set', path: Array(12).fill('d') });
  });

  it('leaves out keys holding functions when asked', () => {
    const prev = { count: 1, inc: () => {} };
    const next = { count: 2, inc: () => {}, reset: () => {} };
    expect(diff(prev, next, { hideFunctions: true }).ops).toEqual([{ op: 'set', path: ['count'], value: 2, prev: 1 }]);
    expect(diff(prev, next).opCount).toBe(3);
  });

  it('previews values with the preview profile', () => {
    const { ops } = diff({ text: 'a' }, { text: 'x'.repeat(500) });
    expect(ops[0]!.value).toEqual({ $t: 'string', v: 'x'.repeat(200), length: 500 });
  });
});

describe('readPath', () => {
  const state = {
    todos: [{ title: 'milk', tags: new Set(['home']) }],
    byId: new Map<unknown, unknown>([[7, { name: 'Ann' }]]),
    empty: undefined,
  };

  it('follows keys into objects, arrays, Maps and Sets', () => {
    expect(readPath(state, ['todos', 0, 'title'])).toEqual({ found: true, value: 'milk' });
    expect(readPath(state, ['todos', '0', 'tags', 0])).toEqual({ found: true, value: 'home' });
    expect(readPath(state, ['byId', '7', 'name'])).toEqual({ found: true, value: 'Ann' });
    expect(readPath(state, [])).toEqual({ found: true, value: state });
  });

  it('tells a missing step from a value that is undefined', () => {
    expect(readPath(state, ['empty'])).toEqual({ found: true, value: undefined });
    expect(readPath(state, ['nope'])).toEqual({ found: false, value: undefined });
    expect(readPath(state, ['todos', 5])).toEqual({ found: false, value: undefined });
    expect(readPath(state, ['todos', 0, 'title', 'length'])).toEqual({ found: false, value: undefined });
    const throwing = {
      get bad(): number {
        throw new Error('nope');
      },
    };
    expect(readPath(throwing, ['bad'])).toEqual({ found: false, value: undefined });
  });
});

describe('createStateEngine', () => {
  const info = { library: 'redux', label: 'Todos', via: 'enhancer', actions: true } as const;

  it('cuts reads to 128 KiB and says so', () => {
    const big = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`key${i}`, 'x'.repeat(1_000)]));
    const state = { big, small: { ok: true } };
    const engine = createStateEngine(() => {}, { connected: () => true }, serialize, diffState, readPath);
    const driver: StoreDriver = { info, getState: () => state, start: () => {} };
    engine.track('redux:1', driver);

    const whole = engine.read('redux:1');
    expect(whole.truncated).toBe(true);
    expect(JSON.stringify(whole.value).length).toBeLessThanOrEqual(128 * 1024);
    expect(engine.read('redux:1', ['small'])).toEqual({ rev: 0, pending: false, value: { ok: true }, truncated: false });
    engine.dispose();
  });

  it('works from its source alone, as the Metro bridge will run it inside apps', async () => {
    const app = vm.createContext({ setTimeout, clearTimeout });
    const inApp = vm.runInContext(
      `({ serialize: ${serialize}, diffState: ${diffState}, readPath: ${readPath}, createStateEngine: ${createStateEngine} })`,
      app,
    ) as { serialize: typeof serialize; diffState: typeof diffState; readPath: typeof readPath; createStateEngine: typeof createStateEngine };
    const events: Array<{ kind: string; payload: unknown }> = [];
    const engine = inApp.createStateEngine(
      (kind, payload) => events.push({ kind, payload }),
      { connected: () => true },
      inApp.serialize,
      inApp.diffState,
      inApp.readPath,
    );
    const store = vm.runInContext(`({ state: { todos: [], when: new Date(0) } })`, app) as { state: { todos: string[]; when: Date } };
    let sink: StateSink | undefined;
    const driver: StoreDriver = { info, getState: () => store.state, start: (s) => void (sink = s) };
    engine.track('redux:1', driver);

    store.state = { ...store.state, todos: ['milk'] };
    sink!.record('redux:1', store.state, { type: 'todos/add', payload: 'milk' });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(JSON.parse(JSON.stringify(events))).toEqual([
      { kind: 'state.store', payload: { store: { id: 'redux:1', ...info } } },
      {
        kind: 'state.change',
        payload: {
          store: 'redux:1',
          rev: 1,
          cause: 'action',
          action: { type: 'todos/add', payload: { payload: 'milk' } },
          ops: [{ op: 'add', path: ['todos', 0], value: 'milk' }],
        },
      },
    ]);
    expect(JSON.parse(JSON.stringify(engine.read('redux:1', ['when'])))).toEqual({
      rev: 1,
      pending: false,
      value: { $t: 'date', v: '1970-01-01T00:00:00.000Z' },
      truncated: false,
    });
    engine.dispose();
  });
});
