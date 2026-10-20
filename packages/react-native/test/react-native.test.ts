import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { devToolSockets, hostFromUrl, portFromUrl } from '../src/host.js';
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

  it("finds Metro's port, so its own sockets can be left out", () => {
    expect(portFromUrl('http://192.168.1.5:8081/index.bundle?platform=ios')).toBe('8081');
    expect(portFromUrl('http://[fe80::1]:8095/index.bundle')).toBe('8095');
    expect(portFromUrl('exp://u.expo.dev/update')).toBeUndefined();
  });

  it("matches dev tools' sockets, including Metro's HMR socket opened with an http:// URL", () => {
    const patterns = devToolSockets('8081');
    const ignored = (url: string) => patterns.some((pattern) => pattern.test(url));
    expect(ignored('http://10.0.2.2:8081/hot?bundleEntry=index.bundle&platform=android')).toBe(true);
    expect(ignored('ws://localhost:8081/hot')).toBe(true);
    expect(ignored('ws://localhost:8081/inspector/device?name=x')).toBe(true);
    expect(ignored('ws://localhost:8097')).toBe(true);
    expect(ignored('ws://192.168.1.5:9090/')).toBe(true);
    expect(ignored('wss://api.example.com/ws?token=x')).toBe(false);
    expect(ignored('http://localhost:8081/api/users')).toBe(false);
    expect(devToolSockets(undefined)).toHaveLength(1);
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
    multiSet: async (pairs: [string, string][]) => {
      for (const [k, v] of pairs) data.set(k, v);
    },
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

  it('leaves a wrapper installed after its own when unsubscribed, and reports nothing through it', async () => {
    const store = fakeAsyncStorage();
    const onChange = vi.fn();
    const unsubscribe = asyncStorage(store).watch!(onChange);
    const ours = store.setItem;
    const theirs = (key: string, value: string) => ours(key, value);
    store.setItem = theirs;

    unsubscribe();
    expect(store.setItem).toBe(theirs);
    await store.setItem('a', '1');
    await Promise.resolve();
    expect(store.data.get('a')).toBe('1');
    expect(onChange).not.toHaveBeenCalled();
  });
});

/** Native MMKV keeps untyped bytes that every getter decodes; same model as the Metro reader's tests. */
function nativeMmkv(initial: Record<string, string | number | boolean>): MMKVLike {
  const bytes = new Map<string, Uint8Array>();
  for (const [key, value] of Object.entries(initial)) {
    if (typeof value === 'number') {
      const data = new Uint8Array(8);
      new DataView(data.buffer).setFloat64(0, value, true);
      bytes.set(key, data);
    } else if (typeof value === 'boolean') {
      bytes.set(key, Uint8Array.of(value ? 1 : 0));
    } else {
      const text = new TextEncoder().encode(value);
      const length: number[] = [];
      for (let n = text.length; ; n >>>= 7) {
        if (n < 0x80) { length.push(n); break; }
        length.push((n & 0x7f) | 0x80);
      }
      bytes.set(key, Uint8Array.of(...length, ...text));
    }
  }
  const varint = (data: Uint8Array) => {
    let value = 0;
    for (let i = 0; i < Math.min(data.length, 5); i++) {
      value |= (data[i]! & 0x7f) << (7 * i);
      if (data[i]! < 0x80) return { value, size: i + 1 };
    }
    return undefined;
  };
  return {
    getAllKeys: () => [...bytes.keys()],
    getString(key) {
      const data = bytes.get(key);
      const length = data && varint(data);
      if (!data || !length || length.value > data.length - length.size) return undefined;
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(length.size, length.size + length.value));
      } catch {
        return '';
      }
    },
    getNumber(key) {
      const data = bytes.get(key);
      return data && data.length >= 8 ? new DataView(data.buffer, data.byteOffset).getFloat64(0, true) : undefined;
    },
    getBoolean(key) {
      const data = bytes.get(key);
      const flag = data && varint(data);
      return flag ? flag.value !== 0 : undefined;
    },
    set() {
      throw new Error('Unexpected write');
    },
  };
}

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

  it('infers numbers and booleans from untyped native MMKV bytes', async () => {
    const adapter = mmkvStorage(nativeMmkv({
      count: 42, zero: 0, ratio: 3.14, enabled: false, visible: true,
      short: 'abc', seven: 'abcdefg', unicode: 'Xin chào 😀', json: '{"a":1}', empty: '',
    }));
    const keys = await adapter.keys();
    const values = Object.fromEntries(await Promise.all(keys.map(async (key) => [key, await adapter.get(key)])));
    expect(values).toEqual({
      count: '42', zero: '0', ratio: '3.14', enabled: 'false', visible: 'true',
      short: 'abc', seven: 'abcdefg', unicode: 'Xin chào 😀', json: '{"a":1}',
      // Stored as the same zero byte as false.
      empty: 'false',
    });
  });

  it('keeps web MMKV strings as stored', async () => {
    // react-native-mmkv on the web keeps text in localStorage, and getNumber is Number(text).
    const text = new Map([['code', '007'], ['empty', ''], ['count', '42']]);
    const web: MMKVLike = {
      getAllKeys: () => [...text.keys()],
      getString: (k) => text.get(k),
      getNumber: (k) => (text.has(k) ? Number(text.get(k)) : undefined),
      getBoolean: (k) => (text.has(k) ? text.get(k) === 'true' : undefined),
      set: (k, v) => void text.set(k, String(v)),
    };
    vi.stubGlobal('document', {});
    try {
      const adapter = mmkvStorage(web);
      expect(await adapter.get('code')).toBe('007');
      expect(await adapter.get('empty')).toBe('');
      expect(await adapter.get('count')).toBe('42');
    } finally {
      vi.unstubAllGlobals();
    }
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

describe('entry', () => {
  it('re-exports the same API from core as the web SDK, so apps on both find the same names', () => {
    const fromCore = (file: string) => {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      const blocks = [...source.matchAll(/export (?:type )?\{([^}]*)\} from '@capybara-devtools\/core';/g)];
      return blocks.flatMap((block) => block[1]!.split(',').map((name) => name.trim()).filter(Boolean)).sort();
    };
    const native = fromCore('../src/index.ts');
    expect(native.length).toBeGreaterThan(10);
    expect(native).toEqual(fromCore('../../web/src/index.ts'));
  });
});
