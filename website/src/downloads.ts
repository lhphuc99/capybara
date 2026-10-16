export type Os = 'mac' | 'windows' | 'linux';
export type Arch = 'arm64' | 'x64';
export type Kind = 'dmg' | 'zip' | 'exe' | 'AppImage' | 'tar.gz';

/** The fields of GitHub's "latest release" response that the page uses. */
export interface Release {
  tag_name: string;
  html_url: string;
  published_at: string | null;
  assets: Array<{ name: string; size: number; browser_download_url: string }>;
}

export interface Download {
  os: Os;
  arch: Arch;
  kind: Kind;
  name: string;
  url: string;
  size: number;
}

export interface ParsedRelease {
  version: string;
  date: string | null;
  url: string;
  downloads: Download[];
}

export interface Platform {
  os: Os | 'mobile' | 'unknown';
  arch?: Arch;
}

/** The parts of `navigator` that detectPlatform reads. */
export interface NavigatorLike {
  userAgent: string;
  maxTouchPoints?: number;
  userAgentData?: { platform?: string; mobile?: boolean };
}

// electron-builder names the x64 AppImage x86_64 and every other x64 file x64.
const ASSET = /^Capybara-(\d+\.\d+\.\d+(?:-[\w.]+)?)-(mac|win|linux)-(arm64|x64|x86_64)\.(dmg|zip|exe|AppImage|tar\.gz)$/;
const OS_ORDER: Os[] = ['mac', 'windows', 'linux'];
const OS_NAMES = { mac: 'mac', win: 'windows', linux: 'linux' } as const;
const FILE_ORDER: Record<Os, string[]> = {
  mac: ['dmg arm64', 'zip arm64', 'dmg x64', 'zip x64'],
  windows: ['exe x64', 'zip x64', 'exe arm64', 'zip arm64'],
  linux: ['AppImage x64', 'AppImage arm64', 'tar.gz x64', 'tar.gz arm64'],
};

export function parseRelease(release: Release): ParsedRelease {
  const version = release.tag_name.replace(/^v/, '');
  const downloads: Download[] = [];
  for (const asset of release.assets) {
    const match = ASSET.exec(asset.name);
    // Checksums, blockmaps, update metadata and files left over from another version.
    if (!match || match[1] !== version) continue;
    downloads.push({
      os: OS_NAMES[match[2] as keyof typeof OS_NAMES],
      arch: match[3] === 'arm64' ? 'arm64' : 'x64',
      kind: match[4] as Kind,
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
    });
  }
  const rank = (download: Download) => {
    const index = FILE_ORDER[download.os].indexOf(`${download.kind} ${download.arch}`);
    return OS_ORDER.indexOf(download.os) * 100 + (index === -1 ? 99 : index);
  };
  downloads.sort((a, b) => rank(a) - rank(b));
  return { version, date: release.published_at, url: release.html_url, downloads };
}

export function detectPlatform(nav: NavigatorLike): Platform {
  const ua = nav.userAgent;
  const hints = nav.userAgentData;
  if (hints?.mobile || /Android|iPhone|iPad|iPod/.test(ua)) return { os: 'mobile' };
  // iPadOS asks for desktop sites with a Mac user agent; only its touch screen gives it away.
  if (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1) return { os: 'mobile' };
  const platform = hints?.platform ?? '';
  // Safari and Firefox say "Intel Mac OS X" on every Mac, so the chip stays unknown here.
  if (platform === 'macOS' || /Macintosh|Mac OS X/.test(ua)) return { os: 'mac' };
  if (platform === 'Windows' || /Windows/.test(ua)) return { os: 'windows', arch: 'x64' };
  if (platform === 'Chrome OS' || /CrOS/.test(ua)) return { os: 'unknown' };
  if (platform === 'Linux' || /Linux|X11/.test(ua)) return { os: 'linux', arch: /aarch64|arm64/.test(ua) ? 'arm64' : 'x64' };
  return { os: 'unknown' };
}

/** Maps Chromium's `getHighEntropyValues(['architecture'])` answer onto build architectures. */
export function archFromHints(architecture: string | undefined): Arch | undefined {
  if (architecture === 'arm') return 'arm64';
  if (architecture === 'x86') return 'x64';
  return undefined;
}

/** The file the hero button offers to this visitor, if there is one for their system. */
export function primaryDownload(downloads: Download[], platform: Platform): Download | undefined {
  const find = (os: Os, kind: Kind, arch?: Arch) =>
    downloads.find((download) => download.os === os && download.kind === kind && (!arch || download.arch === arch));
  switch (platform.os) {
    case 'mac':
      return find('mac', 'dmg', platform.arch ?? 'arm64') ?? find('mac', 'dmg', 'arm64');
    case 'windows':
      return find('windows', 'exe', 'x64');
    case 'linux':
      return find('linux', 'AppImage', platform.arch ?? 'x64');
    default:
      return undefined;
  }
}

export function downloadLabel(download: Download): string {
  switch (download.kind) {
    case 'dmg':
      return 'Disk image (.dmg)';
    case 'exe':
      return 'Installer (.exe)';
    case 'zip':
      return download.os === 'windows' ? 'Portable (.zip)' : 'Archive (.zip)';
    case 'AppImage':
      return `AppImage · ${download.arch}`;
    case 'tar.gz':
      return `Archive (.tar.gz) · ${download.arch}`;
  }
}

// Binary units, as GitHub shows them on the release page.
export function formatSize(bytes: number): string {
  return `${Math.round(bytes / 1_048_576)} MB`;
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(iso));
}
