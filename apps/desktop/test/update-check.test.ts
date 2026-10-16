import { describe, expect, it } from 'vitest';
import { newerRelease, updateMode } from '../src/update-check.js';

describe('updateMode', () => {
  it('installs over NSIS installs, which leave an uninstaller next to the exe', () => {
    const installed = (path: string) => path.endsWith('Uninstall Capybara.exe');
    expect(updateMode('win32', 'C:\\Users\\a\\AppData\\Local\\Programs\\capybara-desktop\\Capybara.exe', {}, installed)).toBe(
      'install',
    );
    expect(updateMode('win32', 'D:\\tools\\Capybara\\Capybara.exe', {}, () => false)).toBe('download');
  });

  it('installs over AppImages only', () => {
    expect(updateMode('linux', '/tmp/.mount_Capy/capybara-desktop', { APPIMAGE: '/home/a/Capybara.AppImage' })).toBe('install');
    expect(updateMode('linux', '/opt/Capybara/capybara-desktop', {})).toBe('download');
  });

  it('only offers the download on macOS, where updates need a signed app', () => {
    expect(updateMode('darwin', '/Applications/Capybara.app/Contents/MacOS/Capybara', {}, () => true)).toBe('download');
  });
});

describe('newerRelease', () => {
  const release = { tag_name: 'v0.2.0', html_url: 'https://github.com/lhphuc99/capybara/releases/tag/v0.2.0' };

  it('returns a release newer than the running version', () => {
    expect(newerRelease(release, '0.1.0')).toEqual({ version: '0.2.0', url: release.html_url });
  });

  it('ignores the same or an older release, and unexpected answers', () => {
    expect(newerRelease(release, '0.2.0')).toBeUndefined();
    expect(newerRelease(release, '0.3.0')).toBeUndefined();
    expect(newerRelease({ message: 'API rate limit exceeded' }, '0.1.0')).toBeUndefined();
    expect(newerRelease(null, '0.1.0')).toBeUndefined();
  });
});
