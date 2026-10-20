import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActiveClient } from '@capybara-devtools/core';

// The real package is Flow and native code; init only reads these.
vi.mock('react-native', () => ({
  NativeModules: { SourceCode: { scriptURL: 'http://192.168.1.20:8081/index.bundle?platform=ios' } },
  Platform: {
    OS: 'ios',
    Version: '26.0',
    constants: { interfaceIdiom: 'phone', systemName: 'iOS', osVersion: '26.0', reactNativeVersion: { major: 0, minor: 86, patch: 3 } },
  },
}));

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

beforeEach(() => {
  urls.length = 0;
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  getActiveClient()?.stop();
  vi.unstubAllGlobals();
});

describe('init', () => {
  it('stays off in a release build unless allowed', async () => {
    vi.stubGlobal('__DEV__', false);
    const { init } = await import('../src/index.js');
    expect(init({ port: 1 })).toBeUndefined();
    expect(getActiveClient()).toBeUndefined();
    expect(init({ port: 1, allowProduction: true })).toBe(getActiveClient());
  });

  it('connects to the machine serving the bundle and describes the device', async () => {
    vi.stubGlobal('__DEV__', true);
    const { init } = await import('../src/index.js');
    const client = init();
    expect(urls).toEqual(['ws://192.168.1.20:7357/client']);
    expect(client?.session).toMatchObject({
      appName: 'React Native (ios)',
      platform: 'ios',
      sdk: { name: '@capybara-devtools/react-native' },
      device: { model: 'iPhone', osVersion: 'iOS 26.0' },
      runtime: 'JSC · RN 0.86.3',
    });
    // Storage is on without adapters, so the UI can say how to add them.
    expect(client?.session.plugins).toEqual(['console', 'errors', 'network', 'storage', 'state']);
  });
});
