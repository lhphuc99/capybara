import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackMMKV, watchMetroMMKV } from '../src/metro-mmkv.js';
import { storageExpression } from '../src/metro-storage.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
  vi.useRealTimers();
});

function runtime(source = '', weakRef = true) {
  vi.useFakeTimers();
  const context = createContext({ Date, setInterval, clearInterval, ...(weakRef ? {} : { WeakRef: undefined }) });
  runInContext(`
    globalThis.modules = new Map();
    globalThis.__r = { getModules: () => modules };
    function expose(id, exports, file = 'src/MMKV.ts') {
      modules.set(id, { isInitialized: true, verboseName: '/node_modules/react-native-mmkv/' + file, publicModule: { exports } });
    }
    class MMKV {
      constructor(id = 'private', data = { user: 'Ada' }) { this.id = id; this.data = data; this.calls = []; }
      getFunctionFromCache(name) {
        this.calls.push(name);
        if (name === 'fail') throw failure;
        return key => this.data[key];
      }
      getString(key) { return this.getFunctionFromCache('getString')(key); }
      getNumber(key) { return this.getFunctionFromCache('getNumber')(key); }
      getBoolean(key) { return this.getFunctionFromCache('getBoolean')(key); }
      getAllKeys() { this.getFunctionFromCache('getAllKeys'); return Object.keys(this.data); }
      set(key, value) { this.getFunctionFromCache('set'); this.data[key] = value; return 'written'; }
    }
    const failure = new Error('original failure');
    const original = Object.getOwnPropertyDescriptor(MMKV.prototype, 'getFunctionFromCache');
    const accessPrivate = (() => { const privateStore = new MMKV(); return () => privateStore.getString('user'); })();
    ${source}
  `, context);
  const run = (code: string) => runInContext(code, context);
  const watch = (owner = 'test') => run(`(${trackMMKV.toString()})('watch', ${JSON.stringify(owner)})`);
  const stop = (owner = 'test') => run(`(${trackMMKV.toString()})('stop', ${JSON.stringify(owner)})`);
  const entries = () => run('globalThis.__CAPYBARA_MMKV_TRACKER_V1__?.entries() ?? []');
  cleanups.push(() => run('globalThis.__CAPYBARA_MMKV_TRACKER_V1__?.dispose()'));
  const inspect = async (method: string, params: object = {}) => {
    const state = run(storageExpression(method, params));
    await vi.waitFor(() => expect(state.done).toBe(true), { interval: 1 });
    if (state.error) throw new Error(state.error);
    return JSON.parse(JSON.stringify(state.value));
  };
  return { run, watch, stop, entries, inspect };
}

describe('MMKV runtime discovery', () => {
  it('finds an existing private class instance on its next use and restores the exact method descriptor', async () => {
    const app = runtime('expose(1, { __esModule: true, get MMKV() { return MMKV; } });');
    app.watch();
    expect(app.entries()).toHaveLength(0);
    expect(app.run('accessPrivate()')).toBe('Ada');
    expect(app.entries()).toHaveLength(1);
    const [store] = await app.inspect('list');
    expect(store).toMatchObject({ label: 'MMKV · private', readOnly: true });
    expect((await app.inspect('get', { adapter: store.id, key: 'user' })).value).toBe('Ada');
    app.stop();
    expect(app.entries()).toHaveLength(0);
    expect(app.run('Object.getOwnPropertyDescriptor(MMKV.prototype, "getFunctionFromCache")')).toEqual(app.run('original'));
  });

  it('preserves values, receiver, exceptions and app writes; inspection never adds a write', async () => {
    const app = runtime('expose(1, { MMKV }); const store = new MMKV();');
    app.watch();
    expect(app.run('store.set("user", "Grace")')).toBe('written');
    expect(app.run('store.getString("user")')).toBe('Grace');
    expect(app.run('(() => { try { store.getFunctionFromCache("fail"); } catch (error) { return error === failure; } })()')).toBe(true);
    expect(app.run('store.calls')).toEqual(['set', 'getString', 'fail']);
    const [info] = await app.inspect('list');
    await app.inspect('entries', { adapter: info.id });
    expect(app.run('store.calls.filter(name => name === "set").length')).toBe(1);
  });

  it('captures V4 factory results with immutable Nitro prototypes and restores by removing its shadow', async () => {
    const app = runtime(`
      class NativeMMKV {
        constructor(id) { this._id = id; }
        get id() { return this._id; }
        getAllKeys() { return ['user']; }
        getString(key) { return key === 'user' ? this._id : undefined; }
        getNumber() { return undefined; }
        getBoolean() { return undefined; }
        set() { throw new Error('Unexpected write'); }
      }
      for (const key of Object.getOwnPropertyNames(NativeMMKV.prototype)) {
        const descriptor = Object.getOwnPropertyDescriptor(NativeMMKV.prototype, key);
        Object.defineProperty(NativeMMKV.prototype, key, { ...descriptor, configurable: false, ...('value' in descriptor ? { writable: false } : {}) });
      }
      Object.freeze(NativeMMKV.prototype);
      const oldAccess = (() => { const hidden = new NativeMMKV('old'); return () => hidden.getString('user'); })();
      let creations = 0;
      const factoryPrototype = Object.freeze({ createMMKV(config) { if (this !== factory) throw new Error('Wrong receiver'); creations++; return new NativeMMKV(config.id); } });
      const factory = Object.create(factoryPrototype);
      const factoryOriginal = factory.createMMKV;
      const exports = Object.freeze({ __esModule: true, get getMMKVFactory() { return () => factory; } });
      expose(4, exports, 'src/getMMKVFactory.ts');
      function createMMKV(config) { return factory.createMMKV(config); }
    `);
    app.watch();
    expect(app.run('creations')).toBe(0);
    expect(app.entries()).toHaveLength(0);
    app.run('const fresh = createMMKV({ id: "new", encryptionKey: "do-not-retain" });');
    expect(app.entries()).toHaveLength(1);
    expect(app.entries()[0].store).toBe(app.run('fresh'));
    expect(app.run('oldAccess()')).toBe('old');
    // V4 instances created before attachment remain undiscoverable unless exported.
    expect((await app.inspect('list')).map((store: any) => store.label)).toEqual(['MMKV · new']);
    expect(app.run('creations')).toBe(1);
    app.stop();
    expect(app.run('factory.createMMKV === factoryOriginal')).toBe(true);
    expect(app.run('Object.hasOwn(factory, "createMMKV")')).toBe(false);
  });

  it('keeps exported instance IDs stable when they are also observed', async () => {
    const app = runtime('const store = new MMKV("exported"); expose(1, { store }, "../app/storage.ts"); expose(2, { MMKV });');
    app.watch();
    const [before] = await app.inspect('list');
    app.run('store.getString("user")');
    const after = await app.inspect('list');
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before.id);
    expect((await app.inspect('get', { adapter: before.id, key: 'user' })).value).toBe('Ada');
  });

  it('refreshes leases without stacking hooks and tolerates concurrent Capybara connections', () => {
    const app = runtime('expose(1, { MMKV });');
    app.watch('one');
    const wrapper = app.run('MMKV.prototype.getFunctionFromCache');
    app.watch('two');
    vi.advanceTimersByTime(10_000);
    app.watch('two');
    expect(app.run('MMKV.prototype.getFunctionFromCache')).toBe(wrapper);
    app.stop('one');
    vi.advanceTimersByTime(10_000);
    expect(app.run('accessPrivate()')).toBe('Ada');
    expect(app.entries()).toHaveLength(1);
    vi.advanceTimersByTime(5_000);
    expect(app.run('MMKV.prototype.getFunctionFromCache === original.value')).toBe(true);
    expect(app.entries()).toHaveLength(0);
  });

  it('leaves subsequent patches in place and makes a retained wrapper inert after disconnect', () => {
    const app = runtime('expose(1, { MMKV });');
    app.watch();
    app.run('const wrapped = MMKV.prototype.getFunctionFromCache; const replacement = function (...args) { return wrapped.apply(this, args); }; MMKV.prototype.getFunctionFromCache = replacement;');
    app.stop();
    expect(app.run('MMKV.prototype.getFunctionFromCache === replacement')).toBe(true);
    expect(app.run('accessPrivate()')).toBe('Ada');
    expect(app.entries()).toHaveLength(0);
  });

  it('does not initialize unloaded modules or hook unrelated classes and supports late modules', () => {
    const app = runtime('expose(1, { MMKV }); modules.get(1).isInitialized = false; expose(2, { MMKV }, "../unrelated/MMKV.ts");');
    app.watch();
    expect(app.run('MMKV.prototype.getFunctionFromCache === original.value')).toBe(true);
    app.run('modules.get(1).isInitialized = true');
    app.watch();
    expect(app.run('accessPrivate()')).toBe('Ada');
    expect(app.entries()).toHaveLength(1);
  });

  it('supports multiple copies and a replacement class after Fast Refresh', () => {
    const app = runtime('expose(1, { MMKV });');
    app.watch();
    app.run('accessPrivate()');
    app.run('const newer = class extends MMKV {}; newer.prototype.getFunctionFromCache = original.value; expose(1, { MMKV: newer }); const newStore = new newer("new");');
    app.watch();
    app.run('newStore.getString("user")');
    expect(app.entries()).toHaveLength(2);
  });

  it('skips immutable methods without disrupting calls and bounds strong references without WeakRef', () => {
    const app = runtime('expose(1, { MMKV }); Object.freeze(MMKV.prototype);', false);
    expect(() => app.watch()).not.toThrow();
    expect(app.run('accessPrivate()')).toBe('Ada');
    expect(app.entries()).toHaveLength(0);
    const other = runtime('expose(1, { MMKV });', false);
    other.watch();
    other.run('for (let i = 0; i < 150; i++) new MMKV(String(i)).getString("user");');
    expect(other.entries()).toHaveLength(100);
    other.stop();
    expect(other.entries()).toHaveLength(0);
  });
});

describe('MMKV CDP lifecycle', () => {
  it('serializes a standalone tracker, refreshes the same lease, and stops after an in-flight refresh', async () => {
    const app = runtime('expose(1, { MMKV });');
    let finish!: () => void;
    const call = vi.fn(async (_method: string, params?: any): Promise<any> => {
      app.run(params.expression);
      if (params.expression.endsWith(')') && call.mock.calls.length === 1) await new Promise<void>(resolve => { finish = resolve; });
      return {};
    });
    const watcher = watchMetroMMKV(call, 7);
    expect(call.mock.calls[0]?.[1]).toMatchObject({ contextId: 7, returnByValue: true });
    await watcher.stop();
    finish();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(call).toHaveBeenCalledTimes(2);
    expect(app.run('MMKV.prototype.getFunctionFromCache === original.value')).toBe(true);
  });
});
