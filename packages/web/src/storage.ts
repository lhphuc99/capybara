import type { StorageAdapter } from '@capybara/core';
import type { StorageOp } from '@capybara/protocol';

type Listener = (op: StorageOp, key?: string) => void;

const listeners = new Map<Storage, Set<Listener>>();
let prototypePatched = false;

// Patched once and never undone: with no listeners it costs nothing, and undoing it
// could remove a wrapper another library installed on top of ours.
function patchStoragePrototype(): void {
  if (prototypePatched || typeof Storage === 'undefined') return;
  prototypePatched = true;
  const proto = Storage.prototype;
  const { setItem, removeItem, clear } = proto;
  proto.setItem = function (this: Storage, key: string, value: string) {
    setItem.call(this, key, value);
    notify(this, 'set', String(key));
  };
  proto.removeItem = function (this: Storage, key: string) {
    removeItem.call(this, key);
    notify(this, 'remove', String(key));
  };
  proto.clear = function (this: Storage) {
    clear.call(this);
    notify(this, 'clear');
  };
}

function notify(storage: Storage, op: StorageOp, key?: string): void {
  const bucket = listeners.get(storage);
  if (!bucket) return;
  for (const listener of bucket) {
    try {
      listener(op, key);
    } catch {
      // a broken listener must not break the app's write
    }
  }
}

export function webStorage(storage: Storage, id: string, label: string): StorageAdapter {
  return {
    id,
    label,
    keys: () => {
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key !== null) keys.push(key);
      }
      return keys;
    },
    get: (key) => storage.getItem(key),
    set: (key, value) => storage.setItem(key, value),
    remove: (key) => storage.removeItem(key),
    clear: () => storage.clear(),
    watch(onChange) {
      patchStoragePrototype();
      const bucket = listeners.get(storage) ?? new Set<Listener>();
      listeners.set(storage, bucket);
      bucket.add(onChange);
      // Writes from other tabs only show up as `storage` events.
      const onStorageEvent = (event: StorageEvent) => {
        if (event.storageArea !== storage) return;
        if (event.key === null) onChange('clear');
        else onChange(event.newValue === null ? 'remove' : 'set', event.key);
      };
      window.addEventListener('storage', onStorageEvent);
      return () => {
        bucket.delete(onChange);
        window.removeEventListener('storage', onStorageEvent);
      };
    },
  };
}

export function cookieStorage(): StorageAdapter {
  const read = (): Array<[string, string]> => {
    if (!document.cookie) return [];
    return document.cookie.split('; ').map((part): [string, string] => {
      const index = part.indexOf('=');
      return index < 0 ? [decode(part), ''] : [decode(part.slice(0, index)), decode(part.slice(index + 1))];
    });
  };
  const remove = (key: string) => {
    document.cookie = `${encodeURIComponent(key)}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  };
  return {
    id: 'cookies',
    label: 'Cookies',
    note: 'HttpOnly cookies are invisible to JavaScript. Edits are written with path=/.',
    keys: () => read().map(([key]) => key),
    get: (key) => read().find(([k]) => k === key)?.[1] ?? null,
    set: (key, value) => {
      document.cookie = `${encodeURIComponent(key)}=${encodeURIComponent(value)}; path=/`;
    },
    remove,
    clear: () => {
      for (const [key] of read()) remove(key);
    },
    watch: cookieChanges(),
  };
}

/** The Cookie Store API also reports document.cookie writes; without it, cookies refresh only on demand. */
function cookieChanges(): StorageAdapter['watch'] {
  const store = (globalThis as { cookieStore?: EventTarget }).cookieStore;
  if (!store) return undefined;
  return (onChange) => {
    const listener = (event: Event) => {
      const { changed = [], deleted = [] } = event as Event & {
        changed?: Array<{ name?: string }>;
        deleted?: Array<{ name?: string }>;
      };
      for (const cookie of changed) onChange('set', cookie.name);
      for (const cookie of deleted) onChange('remove', cookie.name);
    };
    store.addEventListener('change', listener);
    return () => store.removeEventListener('change', listener);
  };
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
