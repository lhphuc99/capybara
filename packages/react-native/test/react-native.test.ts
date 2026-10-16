import { describe, expect, it, vi } from 'vitest';
import { hostFromUrl } from '../src/host.js';
import { asyncStorage, mmkvStorage, type MMKVLike } from '../src/storage.js';

describe('hostFromUrl', () => {
  it('finds the dev server host in Metro bundle URLs', () => {
    expect(hostFromUrl('http://192.168.1.5:8081/index.bundle?platform=ios&dev=true')).toBe('192.168.1.5');
    expect(hostFromUrl('http://localhost:8081/index.bundle')).toBe('localhost');
    expect(hostFromUrl('http://[fe80::1]:8081/index.bundle')).toBe('[fe80::1]');
    expect(hostFromUrl('exp://u.expo.dev/update')).toBe('u.expo.dev');
  });

  it('returns undefined for bundles loaded from disk', () => {
    expect(hostFromUrl('file:///data/app/main.jsbundle')).toBeUndefined();
  });
});

function fakeAsyncStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getAllKeys: async () => [...data.keys()],
    getItem: async (key: string) => data.get(key) ?? null,
    setItem: async (key: string, value: string) => void data.set(key, value),
    removeItem: async (key: string) => void data.delete(key),
    mergeItem: async (key: string, value: string) =>
      void data.set(key, JSON.stringify({ ...JSON.parse(data.get(key) ?? '{}'), ...JSON.parse(value) })),
    multiGet: async (keys: readonly string[]) => keys.map((k) => [k, data.get(k) ?? null] as const),
    multiSet: async (pairs: [string, string][]) => pairs.forEach(([k, v]) => data.set(k, v)),
    clear: async () => data.clear(),
  };
}

describe('asyncStorage', () => {
  it('reads and writes through the module', async () => {
    const store = fakeAsyncStorage({ token: 'abc' });
    const adapter = asyncStorage(store);
    expect(await adapter.keys()).toEqual(['token']);
    expect(await adapter.getMany!(['token', 'missing'])).toEqual([
      ['token', 'abc'],
      ['missing', null],
    ]);
    await adapter.set!('user', '{"id":1}');
    expect(store.data.get('user')).toBe('{"id":1}');
    await adapter.clear!();
    expect(store.data.size).toBe(0);
  });

  it('reports writes made through the module and unwraps on unsubscribe', async () => {
    const store = fakeAsyncStorage();
    const originalSetItem = store.setItem;
    const onChange = vi.fn();
    const unsubscribe = asyncStorage(store).watch!(onChange);

    await store.setItem('a', '1');
    await store.mergeItem('a', '{"b":2}');
    await store.multiSet([['c', '3']]);
    await store.removeItem('a');
    await Promise.resolve();
    expect(onChange.mock.calls).toEqual([['set', 'a'], ['merge', 'a'], ['set'], ['remove', 'a']]);

    unsubscribe();
    expect(store.setItem).toBe(originalSetItem);
  });
});

describe('mmkvStorage', () => {
  function fakeMmkv(): MMKVLike & { values: Map<string, string | number | boolean> } {
    const values = new Map<string, string | number | boolean>();
    return {
      values,
      getAllKeys: () => [...values.keys()],
      getString: (k) => (typeof values.get(k) === 'string' ? (values.get(k) as string) : undefined),
      getNumber: (k) => (typeof values.get(k) === 'number' ? (values.get(k) as number) : undefined),
      getBoolean: (k) => (typeof values.get(k) === 'boolean' ? (values.get(k) as boolean) : undefined),
      set: (k, v) => void values.set(k, v),
      remove: (k) => values.delete(k),
      clearAll: () => values.clear(),
    };
  }

  it('shows strings, numbers and booleans as text', async () => {
    const mmkv = fakeMmkv();
    mmkv.set('name', 'Ada');
    mmkv.set('age', 36);
    mmkv.set('admin', true);
    const adapter = mmkvStorage(mmkv);
    expect(await adapter.get('name')).toBe('Ada');
    expect(await adapter.get('age')).toBe('36');
    expect(await adapter.get('admin')).toBe('true');
    expect(await adapter.get('missing')).toBeNull();
  });

  it('removes with remove() or delete() depending on the version', async () => {
    const v4 = fakeMmkv();
    v4.set('k', 'v');
    await mmkvStorage(v4).remove!('k');
    expect(v4.values.has('k')).toBe(false);

    const v3 = { ...fakeMmkv(), remove: undefined, delete: vi.fn() };
    await mmkvStorage(v3).remove!('k');
    expect(v3.delete).toHaveBeenCalledWith('k');
  });
});
