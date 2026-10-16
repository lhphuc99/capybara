// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getActiveClient } from '@devsight/core';
import { cookieStorage, init, webStorage } from '../src/index.js';

afterEach(() => {
  getActiveClient()?.stop();
  localStorage.clear();
});

describe('webStorage', () => {
  it('reads and writes through to the Storage object', async () => {
    const adapter = webStorage(localStorage, 'localStorage', 'Local Storage');
    await adapter.set!('user', '{"id":1}');
    expect(await adapter.keys()).toEqual(['user']);
    expect(await adapter.get('user')).toBe('{"id":1}');
    await adapter.remove!('user');
    expect(await adapter.keys()).toEqual([]);
  });

  it('reports writes the app makes, until unsubscribed', async () => {
    // happy-dom's Storage is a Proxy whose methods run with the unwrapped target as `this`,
    // so they never match the object the app holds. A plain class behaves like browser Storage.
    class MemoryStorage {
      private data = new Map<string, string>();
      get length() {
        return this.data.size;
      }
      key(index: number) {
        return [...this.data.keys()][index] ?? null;
      }
      getItem(key: string) {
        return this.data.get(key) ?? null;
      }
      setItem(key: string, value: string) {
        this.data.set(key, String(value));
      }
      removeItem(key: string) {
        this.data.delete(key);
      }
      clear() {
        this.data.clear();
      }
    }
    vi.stubGlobal('Storage', MemoryStorage);
    vi.resetModules();
    const fresh = await import('../src/storage.js');
    const storage = new MemoryStorage() as unknown as Storage;
    const other = new MemoryStorage() as unknown as Storage;
    const adapter = fresh.webStorage(storage, 'test', 'Test');
    const onChange = vi.fn();
    const unsubscribe = adapter.watch!(onChange);
    storage.setItem('theme', 'dark');
    storage.removeItem('theme');
    storage.clear();
    other.setItem('other', '1');
    expect(onChange.mock.calls).toEqual([['set', 'theme'], ['remove', 'theme'], ['clear', undefined]]);
    unsubscribe();
    storage.setItem('after', '1');
    expect(onChange).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });
});

describe('cookieStorage', () => {
  it('lists, sets and removes cookies', async () => {
    const adapter = cookieStorage();
    await adapter.set!('session id', 'a b');
    expect(await adapter.get('session id')).toBe('a b');
    expect(await adapter.keys()).toContain('session id');
    await adapter.remove!('session id');
    expect(await adapter.get('session id')).toBeNull();
  });
});

describe('init', () => {
  it('creates one client per page and describes the session', () => {
    document.title = 'Shop';
    const client = init({ port: 1 });
    expect(client?.session).toMatchObject({ appName: 'Shop', platform: 'web', sdk: { name: '@devsight/web' } });
    expect(init()).toBe(client);
  });

  it('does nothing when disabled', () => {
    expect(init({ enabled: false })).toBeUndefined();
    expect(getActiveClient()).toBeUndefined();
  });
});
