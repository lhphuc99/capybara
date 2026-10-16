import { describe, expect, it } from 'vitest';
import { compareVersions, isNewerVersion } from '../src/versions.js';

describe('compareVersions', () => {
  it('orders release versions numerically', () => {
    expect(compareVersions('0.2.0', '0.1.0')).toBe(1);
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('v1.2.3', '1.2.4')).toBe(-1);
  });

  it('puts prereleases before their release, in semver order', () => {
    expect(compareVersions('1.0.0-beta.2', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBe(1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    expect(compareVersions('0.1.0', '0.0.0-stage')).toBe(1);
  });

  it('ignores build metadata', () => {
    expect(compareVersions('1.0.0+abc', '1.0.0+def')).toBe(0);
  });

  it('gives up on anything that is not a version', () => {
    expect(compareVersions('latest', '1.0.0')).toBeUndefined();
    expect(compareVersions('1.0', '1.0.0')).toBeUndefined();
  });
});

describe('isNewerVersion', () => {
  it('is true only for a strictly newer version', () => {
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(false);
  });

  it('is false when a version is missing or malformed', () => {
    expect(isNewerVersion(undefined, '0.1.0')).toBe(false);
    expect(isNewerVersion('0.2.0', undefined)).toBe(false);
    expect(isNewerVersion('0.2.0', 'dev')).toBe(false);
  });
});
