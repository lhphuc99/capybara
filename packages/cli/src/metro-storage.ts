import type { RemoteObject } from './cdp.js';

interface Evaluation {
  result?: RemoteObject;
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

type CdpCall = <T>(method: string, params?: object) => Promise<T>;

/** Hermes fails to compile evaluated source containing characters outside the BMP, such as an emoji in a key. */
function asciiLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Hermes does not consistently implement awaitPromise. Keep the result in an object handle and poll it. */
export async function readMetroStorage(
  call: CdpCall,
  contextId: number,
  isActive: () => boolean,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!['list', 'entries', 'get'].includes(method)) throw new Error('Storage through Metro is read-only');
  const input = params as { adapter?: unknown; key?: unknown } | null;
  if (method !== 'list' && (typeof input?.adapter !== 'string' || (method === 'get' && typeof input.key !== 'string'))) {
    throw new Error('Invalid storage command');
  }
  // Only the arguments this reader understands cross into the app, always as JSON literals.
  const args = method === 'list' ? {} : { adapter: input!.adapter, key: input!.key };
  const expression = `(${inspectStorage.toString()})(${JSON.stringify(method)}, ${asciiLiteral(args)})`;
  let objectId: string | undefined;
  const check = () => {
    if (!isActive()) throw new Error('The app reloaded or disconnected. Select its current session.');
  };
  const checked = (reply: Evaluation) => {
    if (reply.exceptionDetails) {
      throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text || 'Storage inspection failed');
    }
    return reply.result;
  };
  try {
    check();
    const initial = await call<Evaluation>('Runtime.evaluate', { expression, contextId, returnByValue: false });
    objectId = initial.result?.objectId;
    checked(initial);
    if (!objectId) throw new Error('This runtime does not support storage inspection through CDP');
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      check();
      const reply = await call<Evaluation>('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function () { return JSON.stringify(this); }',
        returnByValue: true,
      });
      check();
      const json = checked(reply)?.value;
      if (typeof json !== 'string') throw new Error('The app returned an invalid storage result');
      const state = JSON.parse(json) as { done?: boolean; error?: string; value?: unknown };
      if (state.done) {
        if (state.error) throw new Error(state.error);
        return state.value;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Storage did not respond. Make sure the app is running and not paused in the debugger.');
  } finally {
    if (objectId) await call('Runtime.releaseObject', { objectId }).catch(() => {});
  }
}

/**
 * Self-contained: evaluated in the app, without installing a package.
 * Inspects initialized Metro exports. May initialize the known AsyncStorage implementation already
 * in the bundle; never runs arbitrary module factories or MMKV constructors. ESM export getters
 * are read to resolve live bindings, but nested application object getters are skipped.
 */
export function inspectStorage(method: string, params: { adapter?: string; key?: string }) {
  const state: { done: boolean; value?: unknown; error?: string } = { done: false };
  type Store = {
    getAllKeys(): readonly string[] | Promise<readonly string[]>;
    getItem?(key: string): Promise<string | null>;
    multiGet?(keys: string[]): Promise<ReadonlyArray<readonly [string, string | null]>>;
    getString?(key: string): string | undefined;
    getNumber?(key: string): number | undefined;
    getBoolean?(key: string): boolean | undefined;
  };
  type Found = { id: string; label: string; kind: 'async' | 'mmkv'; store: Store };

  const readOwn = (object: object, key: string, exportBinding = false): unknown => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor && 'value' in descriptor) return descriptor.value;
      return exportBinding ? descriptor?.get?.call(object) : undefined;
    } catch {
      return undefined;
    }
  };
  const objectLike = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';

  const discover = (): Found[] => {
    type MetroRequire = ((id: string | number) => unknown) & { getModules?: () => Map<string | number, any> };
    const req = (globalThis as unknown as { __r?: MetroRequire }).__r;
    if (typeof req?.getModules !== 'function') throw new Error('Metro module discovery is unavailable in this runtime');
    const registry = req.getModules();
    const tracker = (globalThis as unknown as {
      __DEVSIGHT_MMKV_TRACKER_V1__?: {
        capture(value: unknown): void;
        entries(): Array<{ id: string; store: object }>;
      };
    }).__DEVSIGHT_MMKV_TRACKER_V1__;
    // Metro inlineRequires leaves this module unloaded until the app first touches storage.
    // Loading this specific library module does not create a new store or write any keys.
    if (typeof req === 'function') {
      for (const [id, module] of registry) {
        const name = String(module?.verboseName ?? '').replace(/\\/g, '/');
        if (!module?.isInitialized && !module?.hasError &&
            /(?:^|\/)@react-native-async-storage\/async-storage\/(?:src|lib\/(?:module|commonjs))\/AsyncStorage\.native\.[jt]s$/.test(name)) {
          req(id);
          break;
        }
      }
    }
    const found: Found[] = [];
    const seen = new Set<object>();
    let visits = 0;
    const visit = (value: unknown, moduleId: string | number, path: string[], name: string) => {
      if (!objectLike(value) || seen.has(value) || ++visits > 20_000 || found.length >= 100) return;
      seen.add(value);
      try {
        const keys = typeof value.getAllKeys === 'function';
        const kind = keys && typeof value.getItem === 'function' && typeof value.setItem === 'function'
          ? 'async'
          : keys && typeof value.getString === 'function' && typeof value.getNumber === 'function' &&
              typeof value.getBoolean === 'function' && typeof value.set === 'function'
            ? 'mmkv' : undefined;
        if (kind) {
          if (kind === 'mmkv') {
            try { tracker?.capture(value); } catch { /* Discovery still works when hooks are unavailable. */ }
          }
          const title = kind === 'async' ? 'AsyncStorage' : 'MMKV';
          // Nitro V4 exposes id through a native prototype getter.
          let instance = readOwn(value, 'id');
          try { if (kind === 'mmkv' && typeof value.id === 'string') instance = value.id; } catch { /* Optional label. */ }
          const source = name.split('/').at(-1) || String(moduleId);
          const suffix = typeof instance === 'string' ? instance : `${source}${path.length ? ` · ${path.join('.')}` : ''}`;
          const tracked = tracker?.entries().find((entry) => entry.store === value);
          found.push({ id: tracked?.id ?? JSON.stringify([moduleId, ...path]), label: `${title} · ${suffix}`, kind, store: value as unknown as Store });
          return;
        }
        if (path.length >= 2) return;
        // Metro's ESM transform exposes `export const storage` and `export default` as getters.
        const exportBindings = path.length === 0 && readOwn(value, '__esModule') === true;
        for (const key of Object.keys(value).slice(0, 100)) {
          visit(readOwn(value, key, exportBindings), moduleId, [...path, key], name);
        }
      } catch {
        // A native host object or Proxy can refuse inspection. Do not disrupt the app.
      }
    };
    let modules = 0;
    for (const [id, module] of registry) {
      if (++modules > 10_000) break;
      if (!module?.isInitialized || module.hasError) continue;
      visit(module.publicModule?.exports, id, [], typeof module.verboseName === 'string' ? module.verboseName : '');
    }
    for (const { id, store } of tracker?.entries() ?? []) visit(store, id, [], 'Observed instance');
    return found;
  };

  // Avoid TextEncoder: it may be absent or lazily initialized by Expo.
  const utf8Size = (value: string) => {
    let size = 0;
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code < 0x80) size++;
      else if (code < 0x800) size += 2;
      else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) {
        size += 4;
        i++;
      } else size += 3;
    }
    return size;
  };

  const read = async (item: Found, key: string): Promise<string | null> => {
    if (item.kind === 'async') return (await item.store.getItem!(key)) ?? null;
    // MMKV stores no types, so every getter decodes the same bytes: 42 reads as '' through getString.
    // A string takes a length byte plus its UTF-8 bytes, while getNumber needs at least 8 bytes, so a
    // decoded string shorter than 7 bytes is real only if getNumber fails.
    const text = item.store.getString!(key);
    if (text !== undefined && (text.length >= 7 || utf8Size(text) >= 7)) return text;
    const number = item.store.getNumber!(key);
    if (number !== undefined && !Number.isNaN(number)) return String(number);
    if (text) return text;
    // `false` and '' are the same single zero byte.
    const bool = item.store.getBoolean!(key);
    return bool === undefined ? text ?? null : String(bool);
  };

  const entry = (key: string, value: string | null, limit: number) => {
    if (value === null) return { key, value: null, size: 0, truncated: false };
    if (typeof value !== 'string') throw new Error('The storage returned a non-string value');
    return { key, value: value.slice(0, limit), size: utf8Size(value), truncated: value.length > limit };
  };

  const execute = async () => {
    if (!['list', 'entries', 'get'].includes(method)) throw new Error('Storage through Metro is read-only');
    const stores = discover();
    if (method === 'list') return stores.map(({ id, label, kind }) => ({
      id, label, readOnly: true, canClear: false,
      note: 'Read-only through Metro. Use Refresh to read the latest values.' +
        (kind === 'mmkv' ? ' MMKV keeps no value types, so they are inferred: false and an empty string are stored alike and show as false, and binary values may not display.' : ''),
    }));
    const item = stores.find((store) => store.id === params.adapter);
    if (!item) throw new Error('This storage is no longer available. Find stores again after opening the relevant app screen.');
    if (method === 'get') {
      if (typeof params.key !== 'string') throw new Error('Invalid storage key');
      const value = await read(item, params.key);
      return value === null ? null : entry(params.key, value, 1_000_000);
    }
    const allKeys = await item.store.getAllKeys();
    if (!Array.isArray(allKeys) || !allKeys.every((key) => typeof key === 'string')) throw new Error('Invalid storage keys');
    const keys = [...allKeys].sort().slice(0, 1_000);
    const entries: ReturnType<typeof entry>[] = [];
    // Bounded batches avoid holding every full value of a large store at once.
    for (let i = 0; i < keys.length; i += 25) {
      const batch = keys.slice(i, i + 25);
      const pairs = item.kind === 'async' && item.store.multiGet
        ? await item.store.multiGet(batch)
        : await Promise.all(batch.map(async (key) => [key, await read(item, key)] as const));
      for (const [key, value] of pairs) entries.push(entry(key, value ?? null, 2_000));
    }
    return { entries, total: allKeys.length };
  };
  void execute().then(
    (value) => { state.value = value; state.done = true; },
    (error: unknown) => { state.error = error instanceof Error ? error.message : String(error); state.done = true; },
  );
  return state;
}
