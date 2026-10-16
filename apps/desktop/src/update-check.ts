import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isNewerVersion } from '@capybara-devtools/protocol';

/** Where `npm run desktop:release` publishes the installers. */
export const RELEASES_REPO = 'lhphuc99/capybara';

/** `install`: electron-updater can replace this copy in place. `download`: only a new download updates it. */
export type UpdateMode = 'install' | 'download';

export interface Release {
  version: string;
  /** The release page, with its notes and every installer. */
  url: string;
}

/**
 * electron-updater replaces NSIS installs and AppImages. The Windows zip and the Linux tar.gz have
 * nothing it can update, and on macOS Squirrel.Mac only accepts an app signed with a stable
 * identity, which the ad-hoc signed builds are not.
 */
export function updateMode(
  platform: NodeJS.Platform,
  execPath: string,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean = existsSync,
): UpdateMode {
  if (platform === 'win32') return exists(join(dirname(execPath), 'Uninstall Capybara.exe')) ? 'install' : 'download';
  if (platform === 'linux') return env.APPIMAGE ? 'install' : 'download';
  return 'download';
}

export function releasePage(version: string): string {
  return `https://github.com/${RELEASES_REPO}/releases/tag/v${version}`;
}

/** Reads GitHub's "latest release" answer, which never includes drafts or prereleases. */
export function newerRelease(body: unknown, current: string): Release | undefined {
  const release = body as { tag_name?: unknown; html_url?: unknown } | null;
  if (typeof release?.tag_name !== 'string' || typeof release.html_url !== 'string') return undefined;
  const version = release.tag_name.replace(/^v/, '');
  return isNewerVersion(version, current) ? { version, url: release.html_url } : undefined;
}
