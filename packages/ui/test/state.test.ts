import type {
  SerializedValue,
  StateChangePayload,
  StateDiffOp,
  StateEntriesPayload,
  StateEntrySummary,
  StateStoreInfo,
} from '@capybara-devtools/protocol';
import { describe, expect, it } from 'vitest';
import {
  ancestorKeys,
  applyStateEvent,
  changedPaths,
  clearStateRecords,
  diffText,
  emptyStateSlice,
  entryFilters,
  entryFreshness,
  entryMatches,
  entryPills,
  formatOp,
  formatPath,
  graftValue,
  groupOps,
  groupStores,
  isEntryStore,
  libraryContextCount,
  MAX_ENTRIES,
  MAX_RECORDS,
  pathKey,
  pickStore,
  recordLabel,
  recordText,
  stateBadge,
  storeCount,
  type StateEvent,
  type StateRecord,
  type StateSlice,
} from '../src/state';

let seq = 0;
const at = () => ++seq;

const register = (info: Partial<StateStoreInfo> & { id: string }): StateEvent => ({
  seq: at(),
  ts: 1_000,
  kind: 'state.store',
  payload: { store: { library: 'redux', label: info.id, via: 'shim', actions: true, ...info } },
});
const change = (store: string, rev: number, extra: Partial<StateChangePayload> = {}): StateEvent => ({
  seq: at(),
  ts: 2_000,
  kind: 'state.change',
  payload: { store, rev, cause: 'action', action: { type: `action ${rev}` }, ops: [], ...extra },
});
const patch = (store: string, extra: Partial<StateEntriesPayload>): StateEvent => ({
  seq: at(),
  ts: 3_000,
  kind: 'state.entries',
  payload: { store, upserts: [], removed: [], ...extra },
});
const entry = (key: string, extra: Partial<StateEntrySummary> = {}): StateEntrySummary => ({
  key,
  label: key,
  kind: 'query',
  status: 'success',
  fetching: false,
  ...extra,
});
const op = (kind: StateDiffOp['op'], path: StateDiffOp['path'], extra: Partial<StateDiffOp> = {}): StateDiffOp => ({ op: kind, path, ...extra });

/** Applies events as one batch, the way the store applies a server message. */
function apply(events: StateEvent[], slice: StateSlice = emptyStateSlice()): StateSlice {
  const owned = new WeakSet<object>();
  return events.reduce((current, event) => applyStateEvent(current, event, owned), slice);
}

const keys = (slice: StateSlice, store: string) => [...slice.stores[store]!.entries.keys()];

describe('applyStateEvent', () => {
  it('registers stores by library and replaces a registration that keeps its id', () => {
    const slice = apply([
      register({ id: 'redux:1', label: 'shop' }),
      register({ id: 'zustand:1', library: 'zustand', label: 'ui' }),
      change('redux:1', 1),
      register({ id: 'redux:2', label: 'admin' }),
      register({ id: 'redux:1', label: 'shop', disposed: true }),
    ]);
    expect(slice.byLibrary).toEqual({ redux: ['redux:1', 'redux:2'], zustand: ['zustand:1'] });
    expect(slice.stores['redux:1']!.info.disposed).toBe(true);
    expect(slice.stores['redux:1']!.records).toHaveLength(1);
  });

  it('keeps changes in order, tracking rev and marking skipped or missed changes', () => {
    const skippedAt = change('redux:1', 3, { skipped: 12 });
    const missedAt = change('redux:1', 6);
    const slice = apply([
      register({ id: 'redux:1' }),
      change('redux:1', 1, { cause: 'init', action: undefined }),
      change('redux:1', 2, { ops: [op('set', ['a'])], opCount: 140 }),
      skippedAt,
      missedAt,
    ]);
    const view = slice.stores['redux:1']!;
    expect(view.records.map((r) => [r.rev, r.skipped, r.missed, r.opCount])).toEqual([
      [1, 0, 0, 0],
      [2, 0, 0, 140],
      [3, 12, 0, 0],
      [6, 0, 2, 0],
    ]);
    expect(view.rev).toBe(6);
    expect(view.lastSkipped).toBe(missedAt.seq);

    // An app that starts counting again has not lost anything.
    const restarted = apply([change('redux:1', 1)], slice).stores['redux:1']!;
    expect(restarted.records.at(-1)!.missed).toBe(0);
    expect(restarted.rev).toBe(1);
  });

  it(`keeps the newest ${MAX_RECORDS} changes of each store`, () => {
    const events = [register({ id: 'redux:1' })];
    for (let rev = 1; rev <= MAX_RECORDS + 5; rev++) events.push(change('redux:1', rev));
    const { records } = apply(events).stores['redux:1']!;
    expect(records).toHaveLength(MAX_RECORDS);
    expect(records[0]!.rev).toBe(6);
  });

  it('keeps changes of a store it has not seen register, until the registration arrives', () => {
    let slice = apply([change('zustand:3', 4), patch('swr:1', { upserts: [entry('/api/me')] })]);
    expect(slice.stores['zustand:3']!.info).toMatchObject({ library: 'zustand', label: 'zustand:3', actions: true });
    expect(slice.byLibrary).toEqual({ zustand: ['zustand:3'], swr: ['swr:1'] });
    expect(isEntryStore(slice.stores['swr:1']!)).toBe(true);

    slice = apply([register({ id: 'zustand:3', library: 'zustand', label: 'cart', actions: false })], slice);
    expect(slice.stores['zustand:3']!.info.label).toBe('cart');
    expect(slice.stores['zustand:3']!.records).toHaveLength(1);
  });

  it('upserts, removes and resets entries, counting the ones in error', () => {
    let slice = apply([
      register({ id: 'tanstack-query:1', library: 'tanstack-query', actions: false, ops: ['refetch'] }),
      patch('tanstack-query:1', { upserts: [entry('a'), entry('b', { status: 'error' }), entry('c')] }),
    ]);
    expect(keys(slice, 'tanstack-query:1')).toEqual(['a', 'b', 'c']);
    expect(slice.stores['tanstack-query:1']!.errors).toBe(1);

    slice = apply([patch('tanstack-query:1', { upserts: [entry('b')], removed: ['a'] })], slice);
    expect(keys(slice, 'tanstack-query:1')).toEqual(['b', 'c']);
    expect(slice.stores['tanstack-query:1']!.errors).toBe(0);

    expect(slice.stores['tanstack-query:1']!.resets).toBe(0);
    slice = apply([patch('tanstack-query:1', { reset: true, upserts: [entry('d', { status: 'error' })] })], slice);
    expect(keys(slice, 'tanstack-query:1')).toEqual(['d']);
    expect(slice.stores['tanstack-query:1']!.errors).toBe(1);
    expect(slice.stores['tanstack-query:1']!.resets).toBe(1);
  });

  it(`keeps at most ${MAX_ENTRIES} entries per store, dropping the first seen`, () => {
    const upserts = Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => entry(`k${i}`, { status: i < 3 ? 'error' : 'success' }));
    const view = apply([patch('swr:1', { upserts })]).stores['swr:1']!;
    expect(view.entries.size).toBe(MAX_ENTRIES);
    expect(view.entries.keys().next().value).toBe('k5');
    expect(view.errors).toBe(0);
  });

  it('leaves the slice it was given as it was', () => {
    const before = apply([register({ id: 'redux:1' }), change('redux:1', 1), patch('redux:1', { upserts: [entry('a')] })]);
    const view = before.stores['redux:1']!;
    const after = apply([change('redux:1', 2), change('redux:1', 3), patch('redux:1', { removed: ['a'] })], before);
    expect(view.records).toHaveLength(1);
    expect(view.entries.size).toBe(1);
    expect(before.stores['redux:1']).toBe(view);
    expect(after.stores['redux:1']!.records).toHaveLength(3);
    expect(after.stores['redux:1']!.entries.size).toBe(0);
  });

  it('ignores events without a store id', () => {
    const slice = emptyStateSlice();
    const bad = { seq: at(), ts: 0, kind: 'state.change', payload: { rev: 1, ops: [] } } as unknown as StateEvent;
    expect(applyStateEvent(slice, bad)).toBe(slice);
  });
});

describe('clearStateRecords', () => {
  it('keeps stores and entries, empties the timelines, and does not count the next change as missed', () => {
    const slice = apply([
      register({ id: 'redux:1' }),
      change('redux:1', 1),
      change('redux:1', 2),
      patch('swr:1', { upserts: [entry('/api/me')] }),
    ]);
    const cleared = clearStateRecords(slice);
    expect(Object.keys(cleared.stores)).toEqual(['redux:1', 'swr:1']);
    expect(cleared.stores['redux:1']!.records).toEqual([]);
    expect(cleared.stores['swr:1']).toBe(slice.stores['swr:1']);

    const next = apply([change('redux:1', 3)], cleared).stores['redux:1']!;
    expect(next.records.map((r) => r.missed)).toEqual([0]);
  });
});

describe('stores', () => {
  const slice = apply([
    register({ id: 'swr:1', library: 'swr', label: 'default cache', actions: false, ops: ['revalidate'] }),
    register({ id: 'redux:1', label: 'shop', disposed: true }),
    register({ id: 'redux:2', label: 'shop' }),
    register({ id: 'redux:3', label: 'admin', disposed: true }),
    register({ id: 'zustand:1', library: 'zustand', label: 'ui' }),
    change('zustand:1', 1),
    patch('swr:1', { upserts: [entry('/api/me', { status: 'error' }), entry('/api/users')] }),
  ]);

  it('groups stores by library, leaving out disposed ones that a live store replaced', () => {
    expect(groupStores(slice).map((group) => [group.title, group.stores.map((view) => view.info.id)])).toEqual([
      ['Redux', ['redux:2', 'redux:3']],
      ['Zustand', ['zustand:1']],
      ['SWR', ['swr:1']],
    ]);
  });

  it('picks the chosen store by id in its session, by name after a reload, else the first', () => {
    const groups = groupStores(slice);
    const choice = { sessionId: 's1', id: 'redux:3', library: 'redux', label: 'admin' };
    expect(pickStore(groups, choice, 's1')?.info.id).toBe('redux:3');
    expect(pickStore(groups, { ...choice, id: 'redux:1', label: 'shop' }, 's1')?.info.id).toBe('redux:2');
    expect(pickStore(groups, { ...choice, id: 'zustand:9', library: 'zustand', label: 'ui' }, 's2')?.info.id).toBe('zustand:1');
    expect(pickStore(groups, { ...choice, label: 'gone' }, 's2')?.info.id).toBe('redux:2');
    expect(pickStore(groups, null, 's1')?.info.id).toBe('redux:2');
    expect(pickStore([], null, 's1')).toBeUndefined();
  });

  it('lists only the newest live store of a name, which hot reload made again while the old one lives on', () => {
    const reloaded = apply([
      register({ id: 'zustand:1', library: 'zustand', label: 'ui' }),
      register({ id: 'zustand:2', library: 'zustand', label: 'counter' }),
      register({ id: 'zustand:3', library: 'zustand', label: 'ui' }),
      register({ id: 'zustand:4', library: 'zustand', label: 'counter' }),
      register({ id: 'redux:9', label: 'shop' }),
      register({ id: 'redux:10', label: 'shop' }),
      register({ id: 'tanstack-query:1', library: 'tanstack-query', label: 'QueryClient', actions: false }),
      register({ id: 'tanstack-query:2', library: 'tanstack-query', label: 'QueryClient', actions: false }),
      register({ id: 'swr:1', library: 'swr', label: 'default', actions: false }),
      register({ id: 'swr:2', library: 'swr', label: 'default', actions: false }),
      register({ id: 'swr:3', library: 'swr', label: 'cache #1', actions: false, disposed: true }),
    ]);
    const groups = groupStores(reloaded);
    expect(groups.map((group) => [group.title, group.stores.map((view) => view.info.id)])).toEqual([
      ['Redux', ['redux:10']],
      ['Zustand', ['zustand:3', 'zustand:4']],
      ['TanStack Query', ['tanstack-query:2']],
      ['SWR', ['swr:2', 'swr:3']],
    ]);
    expect(stateBadge(reloaded).stores).toBe(6);
    // A store picked before the reload resolves to the newest one of its name, in the same session too.
    const choice = { sessionId: 's1', id: 'zustand:1', library: 'zustand', label: 'ui' };
    expect(pickStore(groups, choice, 's1')?.info.id).toBe('zustand:3');
    expect(pickStore(groups, { ...choice, id: 'redux:9', library: 'redux', label: 'shop' }, 's1')?.info.id).toBe('redux:10');
  });

  it('picks the newest of stores that share a name, live ones first', () => {
    const groups = [
      {
        key: 'context',
        library: 'context',
        title: 'React Context',
        stores: ['context:4', 'context:9', 'context:2'].map((id, i) => ({
          ...apply([register({ id, library: 'context', label: 'Theme', disposed: i === 1 })]).stores[id]!,
        })),
      },
    ];
    expect(pickStore(groups, { sessionId: 's1', id: 'context:1', library: 'context', label: 'Theme' }, 's1')?.info.id).toBe('context:4');
  });

  it('shows entries for cache stores and counts what each one lists', () => {
    expect(isEntryStore(slice.stores['swr:1']!)).toBe(true);
    expect(isEntryStore(slice.stores['zustand:1']!)).toBe(false);
    expect(storeCount(slice.stores['swr:1']!)).toBe(2);
    expect(storeCount(slice.stores['zustand:1']!)).toBe(1);
    expect(stateBadge(slice)).toEqual({ stores: 4, errors: 1 });
  });
});

describe('React Context', () => {
  const context = (id: string, label: string, extra: Partial<StateStoreInfo> = {}) =>
    register({ id, library: 'context', label, via: 'fiber', actions: false, ...extra });
  const slice = apply([
    register({ id: 'redux:1', label: 'shop' }),
    context('context:1', 'ReactRedux', { vendor: 'react-redux' }),
    context('context:2', 'AuthContext'),
    context('context:3', 'Row', { instances: 3 }),
    context('context:4', 'Row #2'),
    context('context:5', 'NavigationContainerInner', { vendor: 'React Navigation', instances: 2 }),
    context('context:6', 'SafeAreaProvider', { vendor: 'react-native-safe-area-context', disposed: true }),
    context('context:7', 'Theme', { disposed: true }),
    context('context:8', 'Theme'),
  ]);

  it("leaves the contexts of libraries out until asked, then lists them apart from the app's", () => {
    const titles = (groups: ReturnType<typeof groupStores>) => groups.map((group) => [group.key, group.title, group.stores.map((view) => view.info.label)]);
    expect(titles(groupStores(slice))).toEqual([
      ['redux', 'Redux', ['shop']],
      ['context', 'React Context', ['AuthContext', 'Row', 'Row #2', 'Theme']],
    ]);
    expect(titles(groupStores(slice, { libraryContexts: true }))).toEqual([
      ['redux', 'Redux', ['shop']],
      ['context', 'React Context', ['AuthContext', 'Row', 'Row #2', 'Theme']],
      ['context:libraries', 'Library contexts', ['ReactRedux', 'NavigationContainerInner', 'SafeAreaProvider']],
    ]);
    expect(libraryContextCount(slice)).toBe(3);
    expect(stateBadge(slice).stores).toBe(5);
    expect(slice.stores['context:3']!.info.instances).toBe(3);
  });

  it('keeps contexts that share a label, which only hot reload or a provider gone and back makes', () => {
    const twins = apply([context('context:1', 'Theme'), context('context:2', 'Theme')]);
    expect(groupStores(twins)[0]!.stores.map((view) => view.info.id)).toEqual(['context:1', 'context:2']);
  });

  it('remembers a library context picked while they were shown, and falls back once they are hidden', () => {
    const choice = { sessionId: 's1', id: 'context:5', library: 'context', label: 'NavigationContainerInner' };
    expect(pickStore(groupStores(slice, { libraryContexts: true }), choice, 's1')?.info.id).toBe('context:5');
    expect(pickStore(groupStores(slice), choice, 's1')?.info.id).toBe('redux:1');
  });

  it('shows changes on a timeline, as provider values have no entries', () => {
    const changed = apply([change('context:2', 1, { cause: 'set', action: undefined, ops: [op('set', ['user'], { value: 'ann' })] })], slice);
    expect(isEntryStore(changed.stores['context:2']!)).toBe(false);
    expect(storeCount(changed.stores['context:2']!)).toBe(1);
  });
});

describe('changes', () => {
  const record = (ops: StateDiffOp[], extra: Partial<StateRecord> = {}): StateRecord => ({
    seq: 1,
    ts: 0,
    rev: 1,
    cause: 'set',
    ops,
    opCount: ops.length,
    skipped: 0,
    missed: 0,
    ...extra,
  });

  it('writes paths the way code reads them', () => {
    expect(formatPath(['cart', 'items', 1])).toBe('cart.items[1]');
    expect(formatPath(['byId', '42', 'name'])).toBe('byId["42"].name');
    expect(formatPath(['my key', 0])).toBe('["my key"][0]');
    expect(formatPath([])).toBe('state');
    expect(pathKey(['items', 1])).toBe(pathKey(['items', '1']));
  });

  it('formats each kind of op, trimming the shared start of long strings', () => {
    expect(formatOp(op('add', ['cart', 'items', 1], { value: { id: 'snack-mochi-03', qty: 2, price: 7.25 } }))).toEqual({
      op: 'add',
      path: 'cart.items[1]',
      value: '{id: "snack-mochi-03", qty: 2, price: 7.25}',
    });
    expect(formatOp(op('set', ['cart', 'total'], { prev: 12.5, value: 27 }))).toEqual({ op: 'set', path: 'cart.total', prev: '12.5', value: '27' });
    expect(formatOp(op('del', ['user', 'token'], { prev: 'abc' }))).toEqual({ op: 'del', path: 'user.token', prev: '"abc"' });
    expect(
      formatOp(op('set', ['cart', 'updatedAt'], { prev: '2026-10-18T14:02:11.384Z', value: '2026-10-18T14:02:14.420Z' })),
    ).toMatchObject({ prev: '"…14:02:11.384Z"', value: '"…14:02:14.420Z"' });
    expect(formatOp(op('set', ['name'], { prev: 'Ada', value: 'Adam' }))).toMatchObject({ prev: '"Ada"', value: '"Adam"' });
  });

  it('lists the paths a record changed, marking the parent of a removed key, and the branches above them', () => {
    const paths = changedPaths(record([op('set', ['cart', 'total']), op('add', ['cart', 'items', 1]), op('del', ['user', 'token'])]));
    expect([...paths]).toEqual([pathKey(['cart', 'total']), pathKey(['cart', 'items', 1]), pathKey(['user'])]);
    expect([...ancestorKeys(paths)]).toEqual([pathKey([]), pathKey(['cart']), pathKey(['cart', 'items'])]);
  });

  it('copies a diff as plain JSON', () => {
    const ops = [op('set', ['cart', 'total'], { prev: 12.5, value: 27 }), op('add', ['when'], { value: { $t: 'date', v: '2026-10-18' } })];
    expect(JSON.parse(diffText(record(ops)))).toEqual([
      { op: 'set', path: 'cart.total', prev: 12.5, value: 27 },
      { op: 'add', path: 'when', value: '2026-10-18' },
    ]);
  });

  it('folds long diffs by branch, a level up when there are too many branches', () => {
    expect(groupOps([op('set', ['a'])])).toBeNull();

    const shifted = Array.from({ length: 30 }, (_, i) => op('set', ['todos', i]));
    expect(groupOps([...shifted, op('set', ['filter'])])?.map((group) => [formatPath(group.path), group.ops.length])).toEqual([
      ['todos', 30],
      ['state', 1],
    ]);

    const renamed = Array.from({ length: 25 }, (_, i) => op(i < 5 ? 'add' : 'set', ['entities', 'users', String(i), 'name']));
    const groups = groupOps(renamed)!;
    expect(groups.map((group) => formatPath(group.path))).toEqual(['entities.users']);
    expect(groups[0]!.counts).toEqual({ add: 5, set: 20, del: 0 });
  });

  it('names records by action, or by the paths they changed', () => {
    expect(recordLabel(record([], { action: { type: 'cart/addItem' } }))).toEqual({ text: 'cart/addItem', system: false });
    expect(recordLabel(record([], { action: { type: '@@INIT' }, cause: 'init' }))).toEqual({ text: '@@INIT', system: true });
    expect(recordLabel(record([], { cause: 'init' }))).toEqual({ text: 'initial state', system: true });
    const ops = [op('set', ['count']), op('set', ['items', 0]), op('set', ['items', 1]), op('set', ['items', 2])];
    expect(recordLabel(record(ops, { opCount: 9 }))).toEqual({ text: 'count, items[0], items[1] +6', system: false });
    expect(recordText(record(ops, { action: { type: 'reorder' } }))).toBe('reorder\ncount\nitems[0]\nitems[1]\nitems[2]');
  });

  it('grafts a value read later into the tree at its path', () => {
    const limit: SerializedValue = { $t: 'limit', name: 'Object' };
    expect(graftValue({ a: { b: limit } }, ['a', 'b'], { c: 1 })).toEqual({ a: { b: { c: 1 } } });
    expect(graftValue([1, [2, limit]], [1, 1], 3)).toEqual([1, [2, 3]]);
    expect(graftValue({ $t: 'array', items: [limit], length: 50 }, [0], 'x')).toEqual({ $t: 'array', items: ['x'], length: 50 });
    expect(graftValue({ $t: 'object', name: 'Cart', props: { items: limit } }, ['items'], [])).toEqual({
      $t: 'object',
      name: 'Cart',
      props: { items: [] },
    });
    expect(graftValue({ $t: 'map', entries: [['k', limit]], size: 1 }, ['k'], 1)).toEqual({ $t: 'map', entries: [['k', 1]], size: 1 });
    expect(graftValue({ $t: 'set', values: [limit], size: 1 }, [0], 2)).toEqual({ $t: 'set', values: [2], size: 1 });
    const unchanged = { a: 1 };
    expect(graftValue(unchanged, ['b', 'c'], 2)).toBe(unchanged);
    expect(graftValue([1], [4], 2)).toEqual([1]);
    expect(graftValue(unchanged, [], 2)).toBe(2);
  });
});

describe('entries', () => {
  it('describes each entry with status chips', () => {
    const pills = (summary: StateEntrySummary) => entryPills(summary).map((pill) => `${pill.text}:${pill.tone}`);
    expect(pills(entry('tea', { stale: false }))).toEqual(['success:ok', 'fresh:muted']);
    expect(pills(entry('user', { stale: true }))).toEqual(['success:ok', 'stale:warn']);
    expect(pills(entry('users', { fetching: true, stale: true }))).toEqual(['fetching:info']);
    expect(pills(entry('user1', { status: 'error', error: 'HTTPError: Request failed with status code 404' }))).toEqual(['error 404:error']);
    expect(pills(entry('boom', { status: 'error', error: 'TypeError: x is undefined' }))).toEqual(['error:error']);
    expect(pills(entry('recs', { status: 'pending', disabled: true }))).toEqual(['disabled:muted']);
    expect(pills(entry('reviews', { active: false, stale: true }))).toEqual(['inactive:muted', 'stale:warn']);
    expect(pills(entry('old', { invalidated: true, stale: true }))).toEqual(['success:ok', 'invalidated:warn']);
    expect(pills(entry('m:1', { kind: 'mutation', active: false }))).toEqual(['success:ok']);
    expect(pills(entry('m:2', { kind: 'mutation', status: 'idle' }))).toEqual(['idle:muted']);
  });

  it('judges freshness only for data fetched successfully', () => {
    expect(entryFreshness(entry('fresh', { stale: false }))).toBe('fresh');
    expect(entryFreshness(entry('old', { stale: true }))).toBe('stale');
    expect(entryFreshness(entry('marked', { stale: false, invalidated: true }))).toBe('invalidated');
    expect(entryFreshness(entry('swr'))).toBeUndefined();
    // TanStack Query marks a query invalidated on every failed fetch.
    const failed = entry('user1', { status: 'error', error: 'HTTPError 404', invalidated: true, stale: true });
    expect(entryFreshness(failed)).toBeUndefined();
    expect(entryMatches(failed, 'stale')).toBe(false);
    expect(entryPills(failed).map((pill) => pill.text)).toEqual(['error 404']);
    expect(entryFreshness(entry('loading', { status: 'pending', stale: true }))).toBeUndefined();
    expect(entryFreshness(entry('m:1', { kind: 'mutation', stale: true }))).toBeUndefined();
  });

  it('offers the Stale and Inactive chips only where entries can be so', () => {
    const swr = [entry('/api/me', { kind: 'swr' }), entry('/api/todos', { kind: 'swr', status: 'error' })];
    expect(entryFilters(swr)).toEqual(['all', 'fetching', 'error']);
    expect(entryFilters([entry('a', { stale: false, active: true })])).toEqual(['all', 'fetching', 'stale', 'error', 'inactive']);
    // No observers, so no staleTime to judge by, but invalidated all the same.
    expect(entryFilters([entry('a', { invalidated: true, active: false })])).toEqual(['all', 'fetching', 'stale', 'error', 'inactive']);
    expect(entryFilters([entry('a', { status: 'error', invalidated: true })])).toEqual(['all', 'fetching', 'error']);
    expect(entryFilters([])).toEqual(['all', 'fetching', 'error']);
  });

  it('filters entries by what they are doing', () => {
    const list = [
      entry('a', { fetching: true }),
      entry('b', { stale: true }),
      entry('c', { invalidated: true }),
      entry('d', { status: 'error' }),
      entry('e', { active: false }),
      entry('m', { kind: 'mutation', active: false }),
    ];
    const match = (filter: Parameters<typeof entryMatches>[1]) => list.filter((e) => entryMatches(e, filter)).map((e) => e.key);
    expect(match('all')).toHaveLength(6);
    expect(match('fetching')).toEqual(['a']);
    expect(match('stale')).toEqual(['b', 'c']);
    expect(match('error')).toEqual(['d']);
    expect(match('inactive')).toEqual(['e']);
  });
});
