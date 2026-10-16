import type { StorageAdapter } from '@devsight/core';

/** Matches the default export of @react-native-async-storage/async-storage. */
export interface AsyncStorageLike {
  getAllKeys(): Promise<readonly string[]>;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  multiGet?(keys: readonly string[]): Promise<ReadonlyArray<readonly [string, string | null]>>;
  clear?(): Promise<void>;
}

/** Matches an instance from react-native-mmkv (v2 to v4). */
export interface MMKVLike {
  getAllKeys(): string[];
  getString(key: string): string | undefined;
  getNumber?(key: string): number | undefined;
  getBoolean?(key: string): boolean | undefined;
  set(key: string, value: string | number | boolean): void;
  /** v2/v3 */
  delete?(key: string): void;
  /** v4 */
  remove?(key: string): unknown;
  clearAll?(): void;
  addOnValueChangedListener?(listener: (key: string) => void): { remove(): void };
}

export interface AdapterOptions {
  id?: string;
  label?: string;
}

export function asyncStorage(storage: AsyncStorageLike, options: AdapterOptions = {}): StorageAdapter {
  const multiGet = storage.multiGet?.bind(storage);
  const clear = storage.clear?.bind(storage);
  return {
    id: options.id ?? 'async-storage',
    label: options.label ?? 'AsyncStorage',
    keys: () => storage.getAllKeys(),
    get: (key) => storage.getItem(key),
    getMany: multiGet ? (keys) => multiGet(keys) : undefined,
    set: (key, value) => storage.setItem(key, value),
    remove: (key) => storage.removeItem(key),
    clear: clear ? () => clear() : undefined,
    // AsyncStorage has no change events, so wrap the module's write methods.
    watch: (onChange) =>
      wrapMethods(storage as unknown as Record<string, unknown>, {
        setItem: (key) => onChange('set', key),
        removeItem: (key) => onChange('remove', key),
        mergeItem: (key) => onChange('merge', key),
        clear: () => onChange('clear'),
        multiSet: () => onChange('set'),
        multiRemove: () => onChange('remove'),
        multiMerge: () => onChange('merge'),
      }),
  };
}

export function mmkvStorage(mmkv: MMKVLike, options: AdapterOptions = {}): StorageAdapter {
  return {
    id: options.id ?? 'mmkv',
    label: options.label ?? 'MMKV',
    // MMKV keeps no type information, so a value is tried as each type in turn.
    note: 'MMKV stores no value types: numbers and booleans are shown best-effort; edits are saved as strings.',
    keys: () => mmkv.getAllKeys(),
    get: (key) => readMmkv(mmkv, key),
    set: (key, value) => mmkv.set(key, value),
    remove: (key) => {
      if (mmkv.remove) mmkv.remove(key);
      else mmkv.delete?.(key);
    },
    clear: mmkv.clearAll ? () => mmkv.clearAll!() : undefined,
    watch: mmkv.addOnValueChangedListener
      ? (onChange) => {
          const listener = mmkv.addOnValueChangedListener!((key) => onChange('unknown', key));
          return () => listener.remove();
        }
      : undefined,
  };
}

function readMmkv(mmkv: MMKVLike, key: string): string | null {
  const text = mmkv.getString(key);
  if (text !== undefined) return text;
  const number = mmkv.getNumber?.(key);
  if (number !== undefined && !Number.isNaN(number)) return String(number);
  const bool = mmkv.getBoolean?.(key);
  if (bool !== undefined) return String(bool);
  return null;
}

/** Runs `hooks[name](firstArg)` after the wrapped method's promise resolves. Returns an undo function. */
function wrapMethods(target: Record<string, unknown>, hooks: Record<string, (key?: string) => void>): () => void {
  const originals: Array<[string, unknown]> = [];
  for (const [name, hook] of Object.entries(hooks)) {
    const original = target[name];
    if (typeof original !== 'function') continue;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const result = (original as (...a: unknown[]) => unknown).apply(this, args);
      const key = typeof args[0] === 'string' ? args[0] : undefined;
      Promise.resolve(result).then(
        () => hook(key),
        () => {},
      );
      return result;
    };
    try {
      target[name] = wrapped;
      originals.push([name, original]);
    } catch {
      // frozen module object: change events are unavailable, everything else still works
    }
  }
  return () => {
    for (const [name, original] of originals) target[name] = original;
  };
}
