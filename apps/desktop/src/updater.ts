import { app, dialog, net, shell, type BrowserWindow, type MessageBoxOptions } from 'electron';
import electronUpdater from 'electron-updater';
import { RELEASES_REPO, newerRelease, releasePage, updateMode, type Release, type UpdateMode } from './update-check.js';

const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 12 * 60 * 60 * 1_000;

type GetWindow = () => BrowserWindow | null;

let checking = false;
/** Background checks ask once per version and launch; Check for Updates always asks. */
let offered: string | undefined;
let updaterReady = false;

export function startUpdateChecks(getWindow: GetWindow): void {
  setTimeout(() => void checkForUpdates(getWindow, false), FIRST_CHECK_MS);
  setInterval(() => void checkForUpdates(getWindow, false), CHECK_EVERY_MS);
}

export async function checkForUpdates(getWindow: GetWindow, manual: boolean): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const mode = updateMode(process.platform, process.execPath, process.env);
    const release = mode === 'install' ? await updaterRelease(getWindow) : await latestRelease();
    if (!release) {
      if (manual) await ask(getWindow, { message: 'Capybara is up to date', detail: `${app.getVersion()} is the newest version.` });
      return;
    }
    if (!manual && offered === release.version) return;
    offered = release.version;
    console.log(`Capybara ${release.version} is available (${mode})`);
    await offer(getWindow, release, mode);
  } catch (error) {
    console.error('Update check failed:', error);
    if (manual) await ask(getWindow, { type: 'error', message: 'Could not check for updates', detail: String(error) });
  } finally {
    checking = false;
  }
}

/** electron-updater finds the release through app-update.yml, the publish settings electron-builder puts in the app. */
async function updaterRelease(getWindow: GetWindow): Promise<Release | undefined> {
  const { autoUpdater } = electronUpdater;
  if (!updaterReady) {
    updaterReady = true;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('download-progress', (progress) => getWindow()?.setProgressBar(progress.percent / 100));
  }
  const result = await autoUpdater.checkForUpdates();
  if (!result?.isUpdateAvailable) return undefined;
  const { version } = result.updateInfo;
  return { version, url: releasePage(version) };
}

/** Builds electron-updater can't replace still get told about new releases. */
async function latestRelease(): Promise<Release | undefined> {
  const response = await net.fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json' },
  });
  // No published release yet.
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub answered ${response.status} ${response.statusText}`);
  return newerRelease(await response.json(), app.getVersion());
}

async function offer(getWindow: GetWindow, release: Release, mode: UpdateMode): Promise<void> {
  for (;;) {
    const response = await ask(getWindow, {
      message: `Capybara ${release.version} is available`,
      detail:
        mode === 'install'
          ? `You have ${app.getVersion()}. Capybara downloads the update in the background, then asks to restart.`
          : `You have ${app.getVersion()}. Download the new version and install it over this one.`,
      buttons: [mode === 'install' ? 'Update' : 'Download', 'Release Notes', 'Later'],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 1) {
      void shell.openExternal(release.url);
      continue;
    }
    if (response === 0 && mode === 'install') await install(getWindow, release);
    else if (response === 0) void shell.openExternal(release.url);
    return;
  }
}

async function install(getWindow: GetWindow, release: Release): Promise<void> {
  const { autoUpdater } = electronUpdater;
  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    console.error('Update download failed:', error);
    getWindow()?.setProgressBar(-1);
    const response = await ask(getWindow, {
      type: 'error',
      message: 'Could not download the update',
      detail: `${String(error)}\n\nYou can download Capybara ${release.version} from its release page instead.`,
      buttons: ['Open Release Page', 'Close'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) void shell.openExternal(release.url);
    return;
  }
  getWindow()?.setProgressBar(-1);
  console.log(`Capybara ${release.version} is downloaded`);
  const response = await ask(getWindow, {
    message: `Capybara ${release.version} is ready`,
    detail: 'Restart now to finish updating. Otherwise it installs when you quit Capybara.',
    buttons: ['Restart', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) autoUpdater.quitAndInstall(true, true);
}

async function ask(getWindow: GetWindow, options: MessageBoxOptions): Promise<number> {
  const box: MessageBoxOptions = { type: 'info', buttons: ['OK'], ...options };
  const window = getWindow();
  const { response } = window ? await dialog.showMessageBox(window, box) : await dialog.showMessageBox(box);
  return response;
}
