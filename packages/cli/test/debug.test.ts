import { afterEach, describe, expect, it, vi } from 'vitest';
import { debug } from '../src/debug.js';

afterEach(() => {
  delete process.env.CAPYBARA_DEBUG;
  vi.restoreAllMocks();
});

describe('debug', () => {
  it('prints only with CAPYBARA_DEBUG set, with the reason', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    debug('Network.enable failed for Shop (iPhone 17)', new Error('Method not found'));
    expect(error).not.toHaveBeenCalled();

    process.env.CAPYBARA_DEBUG = '1';
    debug('Network.enable failed for Shop (iPhone 17)', new Error('Method not found'));
    debug('Reading Shop through Metro on port 8081');
    expect(error.mock.calls).toEqual([
      ['[capybara] Network.enable failed for Shop (iPhone 17): Method not found'],
      ['[capybara] Reading Shop through Metro on port 8081'],
    ]);
  });
});
