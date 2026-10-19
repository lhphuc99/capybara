import { afterEach, describe, expect, it, vi } from 'vitest';
import { getActiveClient } from '@capybara-devtools/core';

// The real package is Flow and native code; init only reads these.
vi.mock('react-native', () => ({
  NativeModules: { SourceCode: { scriptURL: 'http://localhost:8081/index.bundle?platform=ios' } },
  Platform: { OS: 'ios', Version: '26.0', constants: { systemName: 'iOS', osVersion: '26.0' } },
}));

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
});
