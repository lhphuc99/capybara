import type { StorageAdapterInfo, StorageEntries, StorageEntry, StorageOp } from '@capybara-devtools/protocol';
import type { Plugin } from '../client.js';
import { utf8Length } from '../utils.js';

type MaybePromise<T> = T | Promise<T>;

export interface StorageAdapter {
  /** Stable id used in commands, e.g. "localStorage". */
  id: string;
  label: string;
  keys(): MaybePromise<readonly string[]>;
  get(key: string): MaybePromise<string | null | undefined>;
  getMany?(keys: readonly string[]): MaybePromise<ReadonlyArray<readonly [string, string | null | undefined]>>;
  /** Omit to make the storage read-only in the UI. */
  set?(key: string, value: string): MaybePromise<unknown>;
  remove?(key: string): MaybePromise<unknown>;
  clear?(): MaybePromise<unknown>;
  /** Report writes made by the app so the UI can refresh. Returns an unsubscribe function. */
  watch?(onChange: (op: StorageOp, key?: string) => void): () => void;
  /** Shown in the UI, e.g. known limitations. */
  note?: string;
}

/** Keeps a listing of a huge storage from becoming one multi-megabyte message. */
const MAX_ENTRIES = 1_000;
const PREVIEW_CHARS = 2_000;
const VALUE_CHARS = 1_000_000;

export function storagePlugin(adapters: readonly StorageAdapter[]): Plugin {
  const find = (id: string): StorageAdapter => {
    const adapter = adapters.find((a) => a.id === id);
    if (!adapter) throw new Error(`Unknown storage "${id}"`);
    return adapter;
  };

  return {
    name: 'storage',
    setup(ctx) {
      const unsubscribes = adapters.map((adapter) => {
        try {
          return adapter.watch?.((op, key) => ctx.emit('storage.change', { adapter: adapter.id, op, key }));
        } catch {
          return undefined;
        }
      });
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe?.();
      };
    },
    commands: {
      list: (): StorageAdapterInfo[] =>
        adapters.map((a) => ({ id: a.id, label: a.label, readOnly: !a.set, canClear: !!a.clear, note: a.note })),

      entries: async ({ adapter }: { adapter: string }): Promise<StorageEntries> => {
        const a = find(adapter);
        const keys = [...(await a.keys())].sort();
        const shown = keys.slice(0, MAX_ENTRIES);
        const pairs = a.getMany
          ? await a.getMany(shown)
          : await Promise.all(shown.map(async (key) => [key, await a.get(key)] as const));
        return { entries: pairs.map(([key, value]) => toEntry(key, value ?? null, PREVIEW_CHARS)), total: keys.length };
      },

      get: async ({ adapter, key }: { adapter: string; key: string }): Promise<StorageEntry | null> => {
        const value = await find(adapter).get(key);
        return value === undefined || value === null ? null : toEntry(key, value, VALUE_CHARS);
      },

      set: async ({ adapter, key, value }: { adapter: string; key: string; value: string }) => {
        const a = find(adapter);
        if (!a.set) throw new Error(`${a.label} is read-only`);
        await a.set(String(key), String(value));
        return null;
      },

      remove: async ({ adapter, key }: { adapter: string; key: string }) => {
        const a = find(adapter);
        if (!a.remove) throw new Error(`${a.label} is read-only`);
        await a.remove(String(key));
        return null;
      },

      clear: async ({ adapter }: { adapter: string }) => {
        const a = find(adapter);
        if (!a.clear) throw new Error(`${a.label} cannot be cleared`);
        await a.clear();
        return null;
      },
    },
  };
}

function toEntry(key: string, value: string | null, limit: number): StorageEntry {
  if (value === null) return { key, value: null, size: 0, truncated: false };
  const text = String(value);
  const truncated = text.length > limit;
  return { key, value: truncated ? text.slice(0, limit) : text, size: utf8Length(text), truncated };
}
