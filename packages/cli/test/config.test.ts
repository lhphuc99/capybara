import { describe, expect, it } from 'vitest';
import { readPort, remoteUiFrom, updateCheckFrom } from '../src/config.js';

describe('readPort', () => {
  it('reads --port and CAPYBARA_PORT alike, unset or empty meaning the default', () => {
    expect(readPort(undefined, true)).toBe(7357);
    expect(readPort('', true)).toBe(7357);
    expect(readPort(' ', true)).toBe(7357);
    expect(readPort('7400', true)).toBe(7400);
  });

  it('says when the value is not a port, and allows 0 only where any free port will do', () => {
    expect(readPort('0', true)).toBe(0);
    expect(readPort('0', false)).toBeUndefined();
    expect(readPort('abc', true)).toBeUndefined();
    expect(readPort('73.5', true)).toBeUndefined();
    expect(readPort('70000', true)).toBeUndefined();
  });
});

describe('switches from the environment', () => {
  it('turns remote UI on with the flag or CAPYBARA_REMOTE_UI=1, and the npm lookup off with either', () => {
    expect(remoteUiFrom({})).toBe(false);
    expect(remoteUiFrom({ CAPYBARA_REMOTE_UI: '1' })).toBe(true);
    expect(remoteUiFrom({}, true)).toBe(true);
    expect(updateCheckFrom({})).toBe(true);
    expect(updateCheckFrom({ CAPYBARA_NO_UPDATE_CHECK: '1' })).toBe(false);
    expect(updateCheckFrom({}, false)).toBe(false);
  });
});
