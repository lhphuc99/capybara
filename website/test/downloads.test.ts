import { describe, expect, it } from 'vitest';
import {
  archFromHints,
  detectPlatform,
  downloadLabel,
  formatDate,
  formatSize,
  parseRelease,
  primaryDownload,
  type Release,
} from '../src/downloads';
import fixture from './fixtures/release.json';

const release = parseRelease(fixture as Release);

const UA = {
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0',
  linuxArm: 'Mozilla/5.0 (X11; Linux aarch64; rv:144.0) Gecko/20100101 Firefox/144.0',
  android:
    'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  chromeOs: 'Mozilla/5.0 (X11; CrOS x86_64 16328.55.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};

describe('parseRelease', () => {
  it('keeps the eight desktop files, grouped by platform in a fixed order', () => {
    expect(release.version).toBe('0.1.0');
    expect(release.date).toBe('2026-10-16T13:00:00Z');
    expect(release.downloads.map((download) => download.name)).toEqual([
      'Capybara-0.1.0-mac-arm64.dmg',
      'Capybara-0.1.0-mac-arm64.zip',
      'Capybara-0.1.0-win-x64.exe',
      'Capybara-0.1.0-win-x64.zip',
      'Capybara-0.1.0-linux-x86_64.AppImage',
      'Capybara-0.1.0-linux-arm64.AppImage',
      'Capybara-0.1.0-linux-x64.tar.gz',
      'Capybara-0.1.0-linux-arm64.tar.gz',
    ]);
  });

  it('treats the x86_64 AppImage as x64 and keeps sizes and URLs', () => {
    const appImage = release.downloads.find((download) => download.name.endsWith('x86_64.AppImage'));
    expect(appImage).toMatchObject({ os: 'linux', arch: 'x64', kind: 'AppImage', size: 115831803 });
    expect(appImage?.url).toBe(
      'https://github.com/lhphuc99/capybara/releases/download/v0.1.0/Capybara-0.1.0-linux-x86_64.AppImage',
    );
  });

  it('ignores files from another version and anything that is not a package', () => {
    const names = release.downloads.map((download) => download.name);
    expect(names.some((name) => name.includes('0.0.9'))).toBe(false);
    expect(names.some((name) => /blockmap|\.yml|SHA256/.test(name))).toBe(false);
  });

  it('copes with a release that has no packages yet', () => {
    expect(parseRelease({ tag_name: 'v0.2.0', html_url: '', published_at: null, assets: [] }).downloads).toEqual([]);
  });
});

describe('detectPlatform', () => {
  it('recognizes desktop systems from the user agent', () => {
    expect(detectPlatform({ userAgent: UA.macSafari, maxTouchPoints: 0 })).toEqual({ os: 'mac' });
    expect(detectPlatform({ userAgent: UA.windows })).toEqual({ os: 'windows', arch: 'x64' });
    expect(detectPlatform({ userAgent: UA.linuxFirefox })).toEqual({ os: 'linux', arch: 'x64' });
    expect(detectPlatform({ userAgent: UA.linuxArm })).toEqual({ os: 'linux', arch: 'arm64' });
  });

  it('prefers client hints when the browser has them', () => {
    expect(detectPlatform({ userAgent: UA.macChrome, userAgentData: { platform: 'macOS', mobile: false } })).toEqual({
      os: 'mac',
    });
    expect(detectPlatform({ userAgent: UA.android, userAgentData: { platform: 'Android', mobile: true } })).toEqual({
      os: 'mobile',
    });
  });

  it('sends phones, tablets and ChromeOS to the full list instead of guessing', () => {
    expect(detectPlatform({ userAgent: UA.android }).os).toBe('mobile');
    expect(detectPlatform({ userAgent: UA.iphone }).os).toBe('mobile');
    // iPadOS requests the desktop site with a Mac user agent.
    expect(detectPlatform({ userAgent: UA.macSafari, maxTouchPoints: 5 }).os).toBe('mobile');
    expect(detectPlatform({ userAgent: UA.chromeOs }).os).toBe('unknown');
  });

  it('reads the architecture from Chromium client hints', () => {
    expect(archFromHints('arm')).toBe('arm64');
    expect(archFromHints('x86')).toBe('x64');
    expect(archFromHints('')).toBeUndefined();
  });
});

describe('primaryDownload', () => {
  const pick = (platform: Parameters<typeof primaryDownload>[1]) => primaryDownload(release.downloads, platform)?.name;

  it('offers the main package for each system', () => {
    expect(pick({ os: 'mac' })).toBe('Capybara-0.1.0-mac-arm64.dmg');
    expect(pick({ os: 'windows', arch: 'x64' })).toBe('Capybara-0.1.0-win-x64.exe');
    expect(pick({ os: 'linux', arch: 'x64' })).toBe('Capybara-0.1.0-linux-x86_64.AppImage');
    expect(pick({ os: 'linux', arch: 'arm64' })).toBe('Capybara-0.1.0-linux-arm64.AppImage');
  });

  it('offers nothing to phones or unknown systems', () => {
    expect(pick({ os: 'mobile' })).toBeUndefined();
    expect(pick({ os: 'unknown' })).toBeUndefined();
  });

  it('still offers the Apple silicon build when the Mac reports an Intel chip', () => {
    expect(pick({ os: 'mac', arch: 'x64' })).toBe('Capybara-0.1.0-mac-arm64.dmg');
  });
});

describe('formatting', () => {
  it('labels, sizes and dates files the way the page shows them', () => {
    expect(release.downloads.map(downloadLabel)).toEqual([
      'Disk image (.dmg)',
      'Archive (.zip)',
      'Installer (.exe)',
      'Portable (.zip)',
      'AppImage · x64',
      'AppImage · arm64',
      'Archive (.tar.gz) · x64',
      'Archive (.tar.gz) · arm64',
    ]);
    expect(formatSize(111300379)).toBe('106 MB');
    expect(formatDate('2026-10-16T23:30:00Z')).toBe('Oct 16, 2026');
  });
});
