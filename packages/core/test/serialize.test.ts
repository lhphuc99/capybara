import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { serialize } from '../src/serialize.js';

describe('serialize', () => {
  it('keeps JSON-compatible values as they are', () => {
    expect(serialize({ a: 1, b: 'x', c: [true, null] })).toEqual({ a: 1, b: 'x', c: [true, null] });
  });

  it('tags values JSON cannot carry', () => {
    expect(serialize(undefined)).toEqual({ $t: 'undefined' });
    expect(serialize(Number.NaN)).toEqual({ $t: 'number', v: 'NaN' });
    expect(serialize(-0)).toEqual({ $t: 'number', v: '-0' });
    expect(serialize(10n)).toEqual({ $t: 'bigint', v: '10' });
    expect(serialize(Symbol('id'))).toEqual({ $t: 'symbol', v: 'Symbol(id)' });
    expect(serialize(function named() {})).toEqual({ $t: 'function', name: 'named' });
    expect(serialize(new Date('2026-01-02T03:04:05.000Z'))).toEqual({ $t: 'date', v: '2026-01-02T03:04:05.000Z' });
    expect(serialize(/a+/gi)).toEqual({ $t: 'regexp', v: '/a+/gi' });
  });

  it('marks cycles but repeats shared references', () => {
    const shared = { x: 1 };
    const root: Record<string, unknown> = { left: shared, right: shared };
    root.self = root;
    expect(serialize(root)).toEqual({ left: { x: 1 }, right: { x: 1 }, self: { $t: 'circular' } });
  });

  it('serializes errors with stack, cause and custom fields', () => {
    const error = Object.assign(new Error('boom', { cause: 'disk full' }), { code: 'E_IO' });
    const out = serialize(error) as Record<string, unknown>;
    expect(out).toMatchObject({ $t: 'error', name: 'Error', message: 'boom', props: { code: 'E_IO', cause: 'disk full' } });
    expect(typeof out.stack).toBe('string');
  });

  it('describes collections, binary data and class instances', () => {
    class Point {
      x: number;
      constructor(x: number) {
        this.x = x;
      }
    }
    expect(serialize(new Map([['a', 1]]))).toEqual({ $t: 'map', entries: [['a', 1]], size: 1 });
    expect(serialize(new Set([1, 2]))).toEqual({ $t: 'set', values: [1, 2], size: 2 });
    expect(serialize(new Uint8Array(4))).toEqual({ $t: 'binary', name: 'Uint8Array', size: 4 });
    expect(serialize(new Point(1))).toEqual({ $t: 'object', name: 'Point', props: { x: 1 } });
    expect(serialize({ $t: 'fake' })).toEqual({ $t: 'object', props: { $t: 'fake' } });
  });

  it('truncates long strings, arrays, wide objects and deep nesting', () => {
    expect(serialize('x'.repeat(20), { maxString: 5 })).toEqual({ $t: 'string', v: 'xxxxx', length: 20 });
    expect(serialize([1, 2, 3], { maxItems: 2 })).toEqual({ $t: 'array', items: [1, 2], length: 3 });
    expect(serialize({ a: 1, b: 2, c: 3 }, { maxKeys: 2 })).toEqual({ $t: 'object', props: { a: 1, b: 2 }, more: 1 });
    expect(serialize({ a: { b: { c: 1 } } }, { maxDepth: 2 })).toEqual({ a: { b: { $t: 'limit', name: 'Object' } } });
  });

  it('survives getters that throw', () => {
    const obj = {
      ok: 1,
      get bad(): number {
        throw new Error('nope');
      },
    };
    expect(serialize(obj)).toEqual({ ok: 1, bad: { $t: 'error', name: 'Error', message: 'Getter threw: nope' } });
  });

  it('summarizes React elements without walking their owner', () => {
    const element = { $$typeof: Symbol.for('react.transitional.element'), type: 'View', key: null, props: { id: 'a' }, _owner: {} };
    expect(serialize(element)).toEqual({ $t: 'object', name: '<View>', props: { key: null, props: { id: 'a' } } });
  });

  it('works from its source alone, as the Metro bridge runs it inside apps', () => {
    const app = vm.createContext({});
    const inApp = vm.runInContext(`(${serialize.toString()})`, app) as typeof serialize;
    const value = vm.runInContext(
      `({ when: new Date(0), tags: new Set(['a']), byId: new Map([[1, { ok: true }]]), deep: [[[[[[[1]]]]]]] })`,
      app,
    );
    expect(JSON.parse(JSON.stringify(inApp(value)))).toEqual({
      when: { $t: 'date', v: '1970-01-01T00:00:00.000Z' },
      tags: { $t: 'set', values: ['a'], size: 1 },
      byId: { $t: 'map', entries: [[1, { ok: true }]], size: 1 },
      deep: [[[[[{ $t: 'limit', name: 'Array(1)' }]]]]],
    });
  });
});
