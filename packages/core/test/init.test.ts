import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActiveClient, initClient, type PlatformSetup } from '../src/index.js';
import { networkPlugin } from '../src/plugins/network.js';

vi.mock('../src/plugins/network.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/plugins/network.js')>();
  return { ...actual, networkPlugin: vi.fn(actual.networkPlugin) };
});

const urls: string[] = [];
class FakeSocket {
  readyState = 0;
  onopen = null;
  onmessage = null;
  onerror = null;
  onclose = null;
  constructor(url: string) {
    urls.push(url);
  }
  send() {}
  close() {}
}

const platform = (extra: Partial<PlatformSetup> = {}) =>
  vi.fn(
    (): PlatformSetup => ({
      host: 'localhost',
      session: { appName: 'Shop', platform: 'web', sdk: { name: 'test', version: '0' } },
      errors: { name: 'errors' },
      networkNoise: [/\/__nextjs_/],
      ...extra,
    }),
  );

beforeEach(() => {
  urls.length = 0;
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  getActiveClient()?.stop();
  vi.unstubAllGlobals();
});

describe('initClient', () => {
  it('does nothing when turned off or in a release build, without reading the platform', () => {
    const setup = platform();
    expect(initClient({ enabled: false }, false, setup)).toBeUndefined();
    expect(initClient({}, true, setup)).toBeUndefined();
    expect(setup).not.toHaveBeenCalled();
    expect(initClient({ allowProduction: true }, true, setup)).toBe(getActiveClient());
  });

  it('turns on the plugins asked for, with the platform ones', () => {
    const client = initClient({ plugins: [{ name: 'custom' }] }, false, platform({ storage: [] }));
    expect(client?.session.plugins).toEqual(['console', 'errors', 'network', 'storage', 'state', 'custom']);
    client?.stop();
    expect(initClient({ logs: false, network: false, state: false }, false, platform())?.session.plugins).toEqual([]);
  });

  it("leaves the platform's dev tool traffic out, next to the app's own ignores", () => {
    initClient({ network: { ignoreUrls: ['/health'] } }, false, platform());
    expect(vi.mocked(networkPlugin).mock.calls.at(-1)![0]?.ignoreUrls).toEqual([/\/__nextjs_/, '/health']);
  });

  it('connects to the host and port, an IPv6 address in brackets', () => {
    initClient({ port: 7400 }, false, platform())?.stop();
    initClient({ host: '::1' }, false, platform())?.stop();
    initClient({}, false, platform({ host: '[fe80::1]' }))?.stop();
    expect(urls).toEqual(['ws://localhost:7400/client', 'ws://[::1]:7357/client', 'ws://[fe80::1]:7357/client']);
  });

  it('returns the client already running, as after a hot reload', () => {
    const first = initClient({}, false, platform());
    expect(initClient({}, false, platform())).toBe(first);
  });
});
