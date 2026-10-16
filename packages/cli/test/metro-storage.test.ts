import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { inspectStorage, readMetroStorage } from '../src/metro-storage.js';

/**
 * Native MMKV keeps untyped bytes and every getter decodes them: a number is 8 bytes, a boolean 1 byte,
 * a string a varint length plus UTF-8. Measured with MMKV 4.3.2 on iOS; Hermes returns '' for invalid UTF-8.
 */
function nativeMMKV(id: string, values: Record<string, string | number | boolean>) {
  const bytes = new Map<string, Uint8Array>();
  for (const [key, value] of Object.entries(values)) {
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
    id,
    getAllKeys: () => [...bytes.keys()],
    getString(key: string) {
      const data = bytes.get(key);
      const length = data && varint(data);
      if (!data || !length || length.value > data.length - length.size) return undefined;
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(length.size, length.size + length.value));
      } catch {
        return '';
      }
    },
    getNumber(key: string) {
      const data = bytes.get(key);
      return data && data.length >= 8 ? new DataView(data.buffer, data.byteOffset).getFloat64(0, true) : undefined;
    },
    getBoolean(key: string) {
      const data = bytes.get(key);
      const flag = data && varint(data);
      return flag ? flag.value !== 0 : undefined;
    },
    set() { throw new Error('Unexpected write'); },
  };
}

const double = (...bytes: number[]) => new DataView(Uint8Array.from(bytes).buffer).getFloat64(0, true);

function runtime(source = '', globals: Record<string, unknown> = {}) {
  const context = createContext({ ...globals });
  runInContext(`globalThis.modules = new Map(); globalThis.__r = { getModules: () => modules };
    function expose(id, exports, name = 'storage.ts') { modules.set(id, { isInitialized: true, verboseName: name, publicModule: { exports } }); }
    function asyncStore(data) { return {
      getAllKeys: async () => Object.keys(data), getItem: async (key) => data[key] ?? null,
      multiGet: async (keys) => keys.map(key => [key, data[key] ?? null]),
      setItem: () => { throw new Error('Unexpected write'); }
    }; }
    ${source}`, context);
  const inspect = async (method: string, params: object = {}) => {
    const state = runInContext(`(${inspectStorage.toString()})(${JSON.stringify(method)}, ${JSON.stringify(params)})`, context);
    await vi.waitFor(() => expect(state.done).toBe(true), { interval: 1 });
    if (state.error) throw new Error(state.error);
    return JSON.parse(JSON.stringify(state.value));
  };
  return { inspect, run: (expression: string) => runInContext(expression, context) };
}

describe('storage discovery inside a separate JS runtime', () => {
  it('reads an existing AsyncStorage module without loading modules or invoking export getters', async () => {
    const app = runtime(`
      const store = asyncStore({ user: '{"name":"Ada"}', empty: '', unicode: 'Việt 😀' });
      expose(1, { default: store }); expose(2, { storage: store });
      expose(3, Object.defineProperty({}, 'default', { enumerable: true, get() { throw new Error('Getter invoked'); } }));
      modules.set(4, { isInitialized: false, factory() { throw new Error('Module initialized'); }, publicModule: { exports: { default: asyncStore({ hidden: 'x' }) } } });
    `);
    const stores = await app.inspect('list');
    expect(stores).toHaveLength(1);
    expect(stores[0]).toMatchObject({ readOnly: true, canClear: false });
    const { entries, total } = await app.inspect('entries', { adapter: stores[0].id });
    expect(total).toBe(3);
    expect(entries).toEqual([
      { key: 'empty', value: '', size: 0, truncated: false },
      { key: 'unicode', value: 'Việt 😀', size: Buffer.byteLength('Việt 😀'), truncated: false },
      { key: 'user', value: '{"name":"Ada"}', size: 14, truncated: false },
    ]);
    expect(await app.inspect('get', { adapter: stores[0].id, key: 'missing' })).toBeNull();
  });

  it('finds multiple existing MMKV instances with prototype methods and preserves their receiver', async () => {
    const app = runtime(`
      class MMKV {
        constructor(id, data) { this.id = id; this.data = data; }
        getAllKeys() { return Object.keys(this.data); }
        getString(k) { return typeof this.data[k] === 'string' ? this.data[k] : undefined; }
        getNumber(k) { return typeof this.data[k] === 'number' ? this.data[k] : undefined; }
        getBoolean(k) { return typeof this.data[k] === 'boolean' ? this.data[k] : undefined; }
        set() { throw new Error('Unexpected write'); }
      }
      const a = new MMKV('user-storage', { user: 'Ada', count: 2, enabled: false });
      const b = new MMKV('settings', { theme: 'dark' });
      expose(1, { a }); expose(2, { default: { b } }); expose(3, { alias: a });
    `);
    const stores = await app.inspect('list');
    expect(stores.map((s: any) => s.label)).toEqual(['MMKV · user-storage', 'MMKV · settings']);
    expect((await app.inspect('entries', { adapter: stores[0].id })).entries.map((e: any) => [e.key, e.value])).toEqual([
      ['count', '2'], ['enabled', 'false'], ['user', 'Ada'],
    ]);
    expect((await app.inspect('get', { adapter: stores[1].id, key: 'theme' })).value).toBe('dark');
  });

  it('infers MMKV value types from untyped native bytes', async () => {
    const values = {
      count: 42, zero: 0, negative: -1, ratio: 3.14, timestamp: 1_760_000_000_000,
      // Low byte 3 makes getString decode 3 bytes, valid and invalid UTF-8.
      shortText: double(3, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x40),
      invalidText: double(3, 0x85, 0xeb, 0x51, 0xb8, 0x1e, 0x09, 0x40),
      enabled: false, visible: true, empty: '',
      short: 'abc', number: '42', word: 'true', seven: 'abcdefg', unicode: 'Xin chào 😀', json: '{"a":1}',
    };
    const app = runtime('expose(1, { storage });', { storage: nativeMMKV('native', values) });
    const [store] = await app.inspect('list');
    const { entries } = await app.inspect('entries', { adapter: store.id });
    expect(Object.fromEntries(entries.map((entry: any) => [entry.key, entry.value]))).toEqual({
      ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)])),
      // Stored as the same zero byte as false.
      empty: 'false',
    });
    expect(store.note).toContain('show as false');
  });

  it('loads only the known bundled AsyncStorage module when Metro inlineRequires has deferred it', async () => {
    const app = runtime(`
      modules.set(10, { isInitialized: false, verboseName: '../../node_modules/@react-native-async-storage/async-storage/src/AsyncStorage.native.ts', publicModule: { exports: {} } });
      modules.set(11, { isInitialized: false, verboseName: 'app/private-store.ts', publicModule: { exports: {} } });
      globalThis.loaded = [];
      globalThis.__r = Object.assign(function (id) {
        loaded.push(id);
        if (id !== 10) throw new Error('Unexpected module load');
        modules.get(id).isInitialized = true;
        const store = asyncStore({ user: 'Ada' });
        modules.get(id).publicModule.exports = { __esModule: true, get default() { return store; } };
      }, { getModules: () => modules });
    `);
    const [store] = await app.inspect('list');
    expect(store.label).toContain('AsyncStorage');
    expect(JSON.parse(app.run('JSON.stringify(loaded)'))).toEqual([10]);
    expect((await app.inspect('entries', { adapter: store.id })).total).toBe(1);
  });

  it('rescans initialized modules and reports an instance removed by hot reload', async () => {
    const app = runtime();
    expect(await app.inspect('list')).toEqual([]);
    app.run(`expose(1, { storage: asyncStore({ key: 'value' }) })`);
    const [store] = await app.inspect('list');
    app.run('modules.delete(1)');
    await expect(app.inspect('entries', { adapter: store.id })).rejects.toThrow('no longer available');
  });

  it('limits lists and previews, then reads the full selected value on demand', async () => {
    const app = runtime(`const data = Object.fromEntries(Array.from({ length: 1005 }, (_, i) => ['k' + i.toString().padStart(4, '0'), 'x'.repeat(3000)])); expose(1, { default: asyncStore(data) });`);
    const [store] = await app.inspect('list');
    const list = await app.inspect('entries', { adapter: store.id });
    expect(list.total).toBe(1005);
    expect(list.entries).toHaveLength(1000);
    expect(list.entries[0]).toMatchObject({ size: 3000, truncated: true });
    expect(list.entries[0].value).toHaveLength(2000);
    expect((await app.inspect('get', { adapter: store.id, key: 'k0000' })).value).toHaveLength(3000);
  });

  it('surfaces native read errors and rejects writes in the injected reader too', async () => {
    const app = runtime(`expose(1, { default: { ...asyncStore({}), getAllKeys: async () => { throw new Error('Native storage unavailable'); } } });`);
    const [store] = await app.inspect('list');
    await expect(app.inspect('entries', { adapter: store.id })).rejects.toThrow('Native storage unavailable');
    await expect(app.inspect('set', { adapter: store.id })).rejects.toThrow('read-only');
    await expect(app.inspect('clear', { adapter: store.id })).rejects.toThrow('read-only');
  });

  it('reports unsupported Metro discovery instead of pretending storage is empty', async () => {
    const app = runtime('delete globalThis.__r');
    await expect(app.inspect('list')).rejects.toThrow('discovery is unavailable');
  });
});

describe('CDP storage command lifecycle', () => {
  it('quotes user-controlled keys as data and releases the result handle', async () => {
    const app = runtime(`expose(1, { default: asyncStore({}) });`);
    const calls: string[] = [];
    const handles = new Map<string, unknown>();
    const key = `x'); globalThis.injected = true; //`;
    const call = async <T>(method: string, params: any): Promise<T> => {
      calls.push(method);
      if (method === 'Runtime.evaluate') {
        handles.set('result', app.run(params.expression));
        return { result: { type: 'object', objectId: 'result' } } as T;
      }
      if (method === 'Runtime.callFunctionOn') return { result: { value: JSON.stringify(handles.get('result')) } } as T;
      handles.delete('result');
      return {} as T;
    };
    expect(await readMetroStorage(call, 1, () => true, 'get', { adapter: '[1,"default"]', key })).toBeNull();
    expect(app.run('globalThis.injected')).toBeUndefined();
    expect(handles.size).toBe(0);
    expect(calls.at(-1)).toBe('Runtime.releaseObject');
  });

  it('escapes keys outside the BMP, which Hermes cannot compile as raw source', async () => {
    const key = 'emoji 😀 · key';
    const app = runtime(`expose(1, { default: asyncStore({ ${JSON.stringify(key)}: 'astral' }) });`);
    let result: unknown;
    const call = async <T>(method: string, params: any): Promise<T> => {
      if (method === 'Runtime.evaluate') {
        expect(params.expression).not.toMatch(/[\ud800-\udfff]/);
        result = app.run(params.expression);
        return { result: { type: 'object', objectId: 'result' } } as T;
      }
      if (method === 'Runtime.callFunctionOn') return { result: { value: JSON.stringify(result) } } as T;
      return {} as T;
    };
    expect(await readMetroStorage(call, 1, () => true, 'get', { adapter: '[1,"default"]', key })).toMatchObject({ key, value: 'astral' });
  });

  it('cancels results when the app reloads and releases the old handle', async () => {
    let active = true;
    const calls: string[] = [];
    const call = async <T>(method: string): Promise<T> => {
      calls.push(method);
      if (method === 'Runtime.evaluate') { active = false; return { result: { objectId: 'old-context' } } as T; }
      return {} as T;
    };
    await expect(readMetroStorage(call, 1, () => active, 'list', {})).rejects.toThrow('reloaded or disconnected');
    expect(calls).toEqual(['Runtime.evaluate', 'Runtime.releaseObject']);
  });

  it('refuses write commands before evaluating anything in the app', async () => {
    const call = vi.fn();
    await expect(readMetroStorage(call, 1, () => true, 'remove', { key: 'user' })).rejects.toThrow('read-only');
    expect(call).not.toHaveBeenCalled();
  });
});
