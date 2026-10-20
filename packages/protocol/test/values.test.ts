import { describe, expect, it } from 'vitest';
import type { StatePath } from '../src/index.js';
import { formatOp, formatPath, libraryTitle, makeMatcher, parsePath, stateChangeLabel, STATE_LIBRARIES } from '../src/values.js';

describe('state paths', () => {
  it('writes paths the way code reads them', () => {
    expect(formatPath(['cart', 'items', 1])).toBe('cart.items[1]');
    expect(formatPath(['byId', '42', 'name'])).toBe('byId["42"].name');
    expect(formatPath(['my key', 0])).toBe('["my key"][0]');
    expect(formatPath([])).toBe('state');
  });

  it('reads back every path it writes', () => {
    const paths: StatePath[] = [
      ['cart', 'items', 1],
      ['byId', '42', 'name'],
      ['my key', 0],
      [0, 'a'],
      ['a.b', 'x[0]', 'c]d'],
      ['quote"d', "it's", 'back\\slash'],
      ['名前', '', '$id', '_x'],
      ['state'],
      ['m', -1, 1.5],
    ];
    for (const path of paths) expect(parsePath(formatPath(path))).toEqual(path);
    expect(parsePath('')).toEqual([]);
  });

  it('takes the looser forms people write', () => {
    expect(parsePath(' cart.items[0] ')).toEqual(['cart', 'items', 0]);
    expect(parsePath(".cart['my key'][ 2 ]")).toEqual(['cart', 'my key', 2]);
    expect(parsePath('todos[abc].done')).toEqual(['todos', 'abc', 'done']);
    expect(parsePath('user-name.first')).toEqual(['user-name', 'first']);
  });

  it('rejects text that is not a path', () => {
    for (const text of ['a..b', 'a.', 'a[0', 'a[0]b', 'a[]', 'a["b]', "a['b]", 'a]b', 'a["b" c]']) {
      expect(parsePath(text), text).toBeUndefined();
    }
  });
});

describe('state changes', () => {
  it('formats each kind of op, trimming the shared start of long strings', () => {
    expect(formatOp({ op: 'add', path: ['cart', 'items', 1], value: { id: 3, qty: 2 } })).toEqual({
      op: 'add',
      path: 'cart.items[1]',
      value: '{id: 3, qty: 2}',
    });
    expect(formatOp({ op: 'del', path: ['user', 'token'], prev: 'abc' })).toEqual({ op: 'del', path: 'user.token', prev: '"abc"' });
    expect(formatOp({ op: 'set', path: ['at'], prev: '2026-10-18T14:02:11.384Z', value: '2026-10-18T14:02:14.420Z' })).toMatchObject({
      prev: '"…14:02:11.384Z"',
      value: '"…14:02:14.420Z"',
    });
  });

  it('names a change by its action, or by the paths it changed, counting ops cut from the event', () => {
    expect(stateChangeLabel({ cause: 'action', action: { type: 'cart/addItem' }, ops: [] })).toEqual({ text: 'cart/addItem', system: false });
    expect(stateChangeLabel({ cause: 'init', action: { type: '@@INIT' }, ops: [] })).toEqual({ text: '@@INIT', system: true });
    expect(stateChangeLabel({ cause: 'init', ops: [] })).toEqual({ text: 'initial state', system: true });
    expect(stateChangeLabel({ cause: 'external', ops: [] })).toEqual({ text: 'external change', system: true });
    const ops = (['count', 'items', 'total', 'tags'] as const).map((key) => ({ op: 'set' as const, path: [key] }));
    expect(stateChangeLabel({ cause: 'set', ops })).toEqual({ text: 'count, items, total +1', system: false });
    expect(stateChangeLabel({ cause: 'set', ops, opCount: 140 })).toEqual({ text: 'count, items, total +137', system: false });
  });

  it('titles libraries in a fixed order', () => {
    expect(STATE_LIBRARIES).toEqual(['redux', 'zustand', 'xstate', 'mobx', 'tanstack-query', 'swr', 'context']);
    expect(libraryTitle('tanstack-query')).toBe('TanStack Query');
    expect(libraryTitle('jotai')).toBe('jotai');
  });
});

describe('makeMatcher', () => {
  it('reads /pattern/flags as a regular expression, and a path such as /api/users as text', () => {
    expect(makeMatcher('/^GET/i')!.test('get /users')).toBe(true);
    expect(makeMatcher('/api/users')).toMatchObject({ invalid: false });
    expect(makeMatcher('/api/users')!.test('GET https://shop.test/api/users?page=2')).toBe(true);
    expect(makeMatcher('/api/users')!.test('GET https://shop.test/api/orders')).toBe(false);
    expect(makeMatcher('/a(/')).toMatchObject({ invalid: true });
    expect(makeMatcher('  ')).toBeNull();
  });
});
