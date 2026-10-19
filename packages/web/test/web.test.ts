// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getActiveClient, networkPlugin, type NetworkPluginOptions } from '@capybara-devtools/core';
import { cookieStorage, init, webStorage } from '../src/index.js';

vi.mock('@capybara-devtools/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@capybara-devtools/core')>();
  return { ...actual, networkPlugin: vi.fn(actual.networkPlugin) };
});

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

  it('reports cookie changes where the Cookie Store API exists', () => {
    vi.stubGlobal('cookieStore', undefined);
    expect(cookieStorage().watch).toBeUndefined();

    const store = new EventTarget();
    vi.stubGlobal('cookieStore', store);
    const onChange = vi.fn();
    const unsubscribe = cookieStorage().watch!(onChange);
    store.dispatchEvent(Object.assign(new Event('change'), { changed: [{ name: 'consent' }], deleted: [{ name: 'old' }] }));
    expect(onChange.mock.calls).toEqual([['set', 'consent'], ['remove', 'old']]);

    unsubscribe();
    store.dispatchEvent(Object.assign(new Event('change'), { changed: [{ name: 'later' }] }));
    expect(onChange).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});

describe('init', () => {
  it('stays off in a production build unless allowed', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(init({ port: 1 })).toBeUndefined();
      expect(getActiveClient()).toBeUndefined();
      expect(init({ port: 1, allowProduction: true })).toBe(getActiveClient());
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('creates one client per page and describes the session', () => {
    document.title = 'Shop';
    const client = init({ port: 1 });
    expect(client?.session).toMatchObject({ appName: 'Shop', platform: 'web', sdk: { name: '@capybara-devtools/web' } });
    expect(init()).toBe(client);
  });

  it("skips the dev server's own tooling requests and keeps custom ignores", () => {
    init({ port: 1, network: { ignoreUrls: ['/health'] } });
    const options = vi.mocked(networkPlugin).mock.calls.at(-1)![0] as NetworkPluginOptions;
    const ignored = (url: string) =>
      options.ignoreUrls!.some((pattern) => (typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url)));
    expect(ignored('http://localhost:3000/__nextjs_original-stack-frames')).toBe(true);
    expect(ignored('http://localhost:3000/__nextjs_launch-editor?file=app%2Fpage.tsx')).toBe(true);
    expect(ignored('http://localhost:3000/health')).toBe(true);
    expect(ignored('http://localhost:3000/api/hello')).toBe(false);
    expect(ignored('ws://localhost:3000/_next/webpack-hmr?id=x')).toBe(true);
  });

  it("skips Metro's sockets on the page's own origin (Expo web)", () => {
    vi.stubGlobal('location', { host: 'localhost:8081', hostname: 'localhost', href: 'http://localhost:8081/' });
    init({ port: 1 });
    const options = vi.mocked(networkPlugin).mock.calls.at(-1)![0] as NetworkPluginOptions;
    const ignored = (url: string) =>
      options.ignoreUrls!.some((pattern) => (typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url)));
    expect(ignored('ws://localhost:8081/hot')).toBe(true);
    expect(ignored('ws://localhost:8081/message?role=x')).toBe(true);
    expect(ignored('ws://localhost:8081/socket')).toBe(false);
    expect(ignored('ws://chat.example.test/hot')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('runs the state plugin unless turned off', () => {
    expect(init({ port: 1 })?.session.plugins).toContain('state');
    getActiveClient()?.stop();
    expect(init({ port: 1, state: false })?.session.plugins).not.toContain('state');
  });

  it('does nothing when disabled', () => {
    expect(init({ enabled: false })).toBeUndefined();
    expect(getActiveClient()).toBeUndefined();
  });
});
