import { randomUUID } from 'node:crypto';
import type { CdpCall } from './metro-debugger.js';

/** Refresh the runtime lease and discover MMKV modules loaded after the connection was made. */
export function watchMetroMMKV(call: CdpCall, contextId: number) {
  const owner = randomUUID();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const invoke = (action: 'watch' | 'stop') => call('Runtime.evaluate', {
    expression: `(${trackMMKV.toString()})(${JSON.stringify(action)}, ${JSON.stringify(owner)})`,
    contextId,
    returnByValue: true,
  }).catch(() => {});
  const tick = async () => {
    await invoke('watch');
    if (!stopped) {
      timer = setTimeout(() => void tick(), 2_000);
      timer.unref();
    }
  };
  void tick();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      return invoke('stop');
    },
  };
}

/**
 * Self-contained runtime instrumentation. Never loads a Metro module, creates a storage instance,
 * reads keys, or retains factory arguments (which may include encryption keys).
 * V2/V3: intercept the class's shared method cache. V4: shadow the native factory method on its
 * JS object (Nitro prototypes are immutable). All hooks are bounded and reversible.
 */
export function trackMMKV(action: 'watch' | 'stop', owner: string) {
  type AnyObject = Record<string, any>;
  type Entry = { id: string; store: AnyObject };
  type Tracker = {
    version: 1;
    owners: Map<string, number>;
    scan(): void;
    capture(value: unknown): void;
    entries(): Entry[];
    dispose(): void;
  };
  const root = globalThis as unknown as {
    __CAPYBARA_MMKV_TRACKER_V1__?: Tracker;
    __r?: { getModules?: () => Map<string | number, any> };
  };
  let tracker = root.__CAPYBARA_MMKV_TRACKER_V1__;
  if (tracker && tracker.version !== 1) return;
  if (action === 'stop') {
    if (tracker) {
      tracker.owners.delete(owner);
      if (!tracker.owners.size) tracker.dispose();
    }
    return;
  }
  if (!tracker) {
    // A lease timer is required so an abruptly disconnected debugger cannot leave permanent hooks.
    if (typeof setInterval !== 'function' || typeof clearInterval !== 'function') return;
    const owners = new Map<string, number>();
    const stores = new Map<string, { deref(): AnyObject | undefined }>();
    const identities = new WeakMap<object, string>();
    const patched = new WeakMap<object, Set<string>>();
    const patches: Array<{ target: object; key: string; descriptor?: PropertyDescriptor; wrapper: (...args: unknown[]) => unknown }> = [];
    let sequence = 0;
    let disposed = false;
    let expiry: ReturnType<typeof setInterval>;
    const own = (object: object, key: string, exportBinding = false): unknown => {
      const d = Object.getOwnPropertyDescriptor(object, key);
      return d && 'value' in d ? d.value : exportBinding ? d?.get?.call(object) : undefined;
    };
    const isStore = (value: unknown): value is AnyObject => value !== null && typeof value === 'object' &&
      ['getAllKeys', 'getString', 'getNumber', 'getBoolean', 'set'].every((key) => typeof (value as AnyObject)[key] === 'function');
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      clearInterval(expiry);
      for (const { target, key, descriptor, wrapper } of patches.reverse()) {
        try {
          // Do not overwrite another debugger's or the app's subsequent patch.
          if (Object.getOwnPropertyDescriptor(target, key)?.value === wrapper) {
            if (descriptor) Object.defineProperty(target, key, descriptor);
            else Reflect.deleteProperty(target, key);
          }
        } catch { /* A subsequently frozen prototype cannot be restored. The wrapper stays inert. */ }
      }
      patches.length = 0;
      stores.clear();
      owners.clear();
      if (root.__CAPYBARA_MMKV_TRACKER_V1__ === created) delete root.__CAPYBARA_MMKV_TRACKER_V1__;
    };
    const active = () => {
      if (disposed) return false;
      const now = Date.now();
      for (const [id, deadline] of owners) if (deadline <= now) owners.delete(id);
      if (!owners.size) dispose();
      return !disposed;
    };
    const patch = (target: object, key: string, factory = false, inherited?: PropertyDescriptor) => {
      if (patches.length >= 128 || patched.get(target)?.has(key)) return;
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      const source = descriptor ?? inherited;
      if (!source || typeof source.value !== 'function') return;
      if (descriptor ? (!descriptor.configurable && !descriptor.writable) : !Object.isExtensible(target)) return;
      const original = source.value as (...args: unknown[]) => unknown;
      const wrapper = function (this: unknown, ...args: unknown[]) {
        // Let the original method own its receiver, return value, and exceptions.
        const result = Reflect.apply(original, this, args);
        try { capture(factory ? result : this); } catch { /* Inspection must never break an app call. */ }
        return result;
      };
      Object.defineProperty(target, key, descriptor
        ? { ...descriptor, value: wrapper }
        : { value: wrapper, configurable: true, enumerable: source.enumerable, writable: true });
      if (Object.getOwnPropertyDescriptor(target, key)?.value !== wrapper) return;
      const keys = patched.get(target) ?? new Set<string>();
      keys.add(key);
      patched.set(target, keys);
      patches.push({ target, key, descriptor, wrapper });
    };
    const hookPrototype = (prototype: AnyObject) => {
      if (!isStore(prototype)) return;
      if (typeof own(prototype, 'getFunctionFromCache') === 'function') {
        patch(prototype, 'getFunctionFromCache');
      } else {
        // Covers writable class variants; frozen Nitro prototypes are skipped.
        for (const key of ['getAllKeys', 'getString', 'getNumber', 'getBoolean', 'getBuffer', 'contains', 'set', 'remove', 'delete', 'clearAll']) {
          try { patch(prototype, key); } catch { /* Some native properties cannot be replaced. */ }
        }
      }
    };
    const capture = (value: unknown) => {
      if (!active() || !isStore(value)) return;
      if (identities.has(value)) return;
      // Prefer WeakRef where available; otherwise retain at most 100 instances until disconnect.
      for (const [id, ref] of stores) if (!ref.deref()) stores.delete(id);
      if (stores.size < 100) {
        const id = `mmkv-runtime:${owner}:${++sequence}`;
        identities.set(value, id);
        stores.set(id, typeof WeakRef === 'function' ? new WeakRef(value) : { deref: () => value });
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype && prototype !== Object.prototype) hookPrototype(prototype);
    };
    const factories = new WeakSet<object>();
    const scan = () => {
      if (!active() || typeof root.__r?.getModules !== 'function') return;
      let visited = 0;
      for (const module of root.__r.getModules().values()) {
        if (++visited > 10_000) break;
        if (!module?.isInitialized || module.hasError) continue;
        const name = String(module.verboseName ?? '').replace(/\\/g, '/');
        if (!/(?:^|\/)react-native-mmkv\/(?:package\/)?(?:src|lib(?:\/(?:module|commonjs))?)\/(?:MMKV|index|getMMKVFactory)\.[jt]sx?$/.test(name)) continue;
        try {
          const exports = module.publicModule?.exports;
          if (!exports || (typeof exports !== 'object' && typeof exports !== 'function')) continue;
          const esm = own(exports, '__esModule') === true;
          const MMKV = own(exports, 'MMKV', esm);
          if (typeof MMKV === 'function' && MMKV.prototype) hookPrototype(MMKV.prototype);
          // Only the known, initialized V4 library module can supply this accessor. It may
          // initialize the shared native factory, but does not open/create an MMKV store.
          const getFactory = own(exports, 'getMMKVFactory', esm);
          if (typeof getFactory === 'function' && !factories.has(getFactory)) {
            const factory = getFactory();
            let target = factory;
            for (let depth = 0; target && target !== Object.prototype && depth < 4; depth++, target = Object.getPrototypeOf(target)) {
              const descriptor = Object.getOwnPropertyDescriptor(target, 'createMMKV');
              if (descriptor) { patch(factory, 'createMMKV', true, descriptor); break; }
            }
            factories.add(getFactory);
          }
        } catch { /* Unsupported, frozen, or unavailable native modules are left alone. */ }
      }
    };
    const created: Tracker = {
      version: 1, owners, scan, capture, dispose,
      entries: () => active() ? [...stores].flatMap(([id, ref]) => {
        const store = ref.deref();
        if (!store) { stores.delete(id); return []; }
        return [{ id, store }];
      }) : [],
    };
    tracker = created;
    root.__CAPYBARA_MMKV_TRACKER_V1__ = created;
    expiry = setInterval(() => { active(); }, 5_000);
  }
  tracker.owners.set(owner, Date.now() + 15_000);
  tracker.scan();
}
