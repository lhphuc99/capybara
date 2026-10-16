import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PORT } from '@capybara-devtools/protocol';
import { fetchLatestVersions, reverseAndroidPorts, startMetroBridge, type MetroBridge, type ServerOptions } from 'capybara-devtools';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron';
import { listen, PortInUseError, startOrReuse, type Started } from './server.js';
import { checkForUpdates, startUpdateChecks } from './updater.js';

const TAKEOVER_INTERVAL_MS = 2_000;
const APPEARANCES = ['system', 'light', 'dark'] as const;
type Appearance = (typeof APPEARANCES)[number];

let url = '';
let mainWindow: BrowserWindow | null = null;
let metroBridge: MetroBridge | undefined;
let takeoverTimer: ReturnType<typeof setTimeout> | undefined;
let quitting = false;

app.on('before-quit', () => {
  quitting = true;
  clearTimeout(takeoverTimer);
  metroBridge?.stop();
});

if (!app.requestSingleInstanceLock()) {
  // A second copy would only find the port taken by the first one.
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('window-all-closed', () => {
    // Mac apps stay in the Dock without windows; the server keeps collecting events meanwhile.
    if (process.platform !== 'darwin') app.quit();
  });
  void app.whenReady().then(main);
}

async function main() {
  // The UI owns the Appearance setting; keeping a copy here gives the window the right colors before it loads.
  nativeTheme.themeSource = readAppearance();
  nativeTheme.on('updated', () => mainWindow?.setBackgroundColor(windowBackground()));
  ipcMain.on('appearance', (event, value: unknown) => {
    if (event.sender !== mainWindow?.webContents || !isAppearance(value) || value === nativeTheme.themeSource) return;
    nativeTheme.themeSource = value;
    saveAppearance(value);
  });

  const updates: MenuItemConstructorOptions[] = app.isPackaged
    ? [{ label: 'Check for Updates…', click: () => void checkForUpdates(() => mainWindow, true) }]
    : [];
  // Electron's default menu has a Help menu linking to electronjs.org.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      process.platform === 'darwin'
        ? {
            label: app.name,
            submenu: [
              { role: 'about' },
              ...updates,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          }
        : { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      ...(process.platform !== 'darwin' && updates.length > 0 ? [{ label: 'Help', submenu: updates }] : []),
    ]),
  );

  const checkUpdates = !process.env.CAPYBARA_NO_UPDATE_CHECK;
  const options: ServerOptions = {
    port: Number(process.env.CAPYBARA_PORT || DEFAULT_PORT),
    uiDir: join(app.getAppPath(), 'dist', 'ui'),
    version: app.getVersion(),
    latestVersions: checkUpdates ? () => fetchLatestVersions() : undefined,
  };
  const started = await start(options);
  if (!started) {
    app.quit();
    return;
  }
  url = `http://localhost:${started.port}`;
  if (started.server) {
    console.log(`Capybara server on port ${started.port}`);
    reverseAndroidPorts(started.port, findAdb());
    metroBridge = startMetroBridge({ port: started.port, version: app.getVersion() });
  } else {
    console.log(`Using the Capybara server already running on port ${started.port}`);
    takeOverWhenFree(options);
  }
  showWindow();
  if (app.isPackaged && checkUpdates) startUpdateChecks(() => mainWindow);
}

async function start(options: ServerOptions): Promise<Started | undefined> {
  for (;;) {
    try {
      return await startOrReuse(options);
    } catch (error) {
      const inUse = error instanceof PortInUseError;
      const { response } = await dialog.showMessageBox({
        type: 'error',
        message: inUse ? `Port ${options.port} is in use` : 'Capybara could not start its server',
        detail: inUse
          ? `Another program is using port ${options.port}, the port apps connect to. Quit that program, then try again.`
          : String(error),
        buttons: ['Try Again', 'Quit'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 1) return undefined;
    }
  }
}

/** Once the other process exits (e.g. `npx capybara-devtools` is stopped), apps reconnect to this app instead. */
function takeOverWhenFree(options: ServerOptions) {
  if (quitting) return;
  takeoverTimer = setTimeout(async () => {
    const own = await listen(options).catch(() => null);
    if (quitting) {
      await own?.server.close();
      return;
    }
    if (!own) {
      takeOverWhenFree(options);
      return;
    }
    console.log(`Took over port ${own.port}`);
    reverseAndroidPorts(own.port, findAdb());
    metroBridge = startMetroBridge({ port: own.port, version: app.getVersion() });
    // The page came from the other server, which may be a different version.
    if (mainWindow) load(mainWindow);
  }, TAKEOVER_INTERVAL_MS);
}

/** Opened from the Dock or Start menu, the app doesn't get the shell's PATH, so look where the Android SDK keeps adb. */
function findAdb(): string {
  const sdks = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    // Android Studio's default SDK location on each platform.
    process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Android', 'Sdk')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Android', 'sdk')
        : join(homedir(), 'Android', 'Sdk'),
  ];
  const binary = process.platform === 'win32' ? 'adb.exe' : 'adb';
  for (const sdk of sdks) {
    const adb = sdk && join(sdk, 'platform-tools', binary);
    if (adb && existsSync(adb)) return adb;
  }
  return 'adb';
}

function showWindow() {
  if (!url) return;
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    return;
  }
  mainWindow = createWindow();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    title: 'Capybara',
    // Windows takes the icon from the exe and macOS from the app bundle; a Linux binary has none.
    icon: process.platform === 'linux' ? join(app.getAppPath(), 'dist', 'icon.png') : undefined,
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: join(app.getAppPath(), 'dist', 'preload.cjs'),
      // A hidden or covered window would otherwise get throttled timers and show incoming events in bursts.
      backgroundThrottling: false,
    },
  });
  const { webContents } = window;
  // The window only ever shows the UI; links open in the default browser.
  webContents.setWindowOpenHandler(({ url: target }) => {
    openExternal(target);
    return { action: 'deny' };
  });
  webContents.on('will-navigate', (event) => {
    if (new URL(event.url).origin === url) return;
    event.preventDefault();
    openExternal(event.url);
  });
  webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    // -3 is a load replaced by a newer one. Anything else: the server is restarting or changing hands.
    if (isMainFrame && code !== -3) setTimeout(() => load(window), 1_000);
  });
  load(window);
  return window;
}

function load(window: BrowserWindow) {
  if (!window.isDestroyed()) window.loadURL(url).catch(() => {});
}

/** The UI's --bg, so the window doesn't flash the other color before the page paints. */
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#0e1116' : '#ffffff';
}

function isAppearance(value: unknown): value is Appearance {
  return APPEARANCES.includes(value as Appearance);
}

const settingsFile = () => join(app.getPath('userData'), 'settings.json');

function readAppearance(): Appearance {
  try {
    const { appearance } = JSON.parse(readFileSync(settingsFile(), 'utf8')) as { appearance?: unknown };
    return isAppearance(appearance) ? appearance : 'system';
  } catch {
    return 'system';
  }
}

function saveAppearance(appearance: Appearance) {
  try {
    writeFileSync(settingsFile(), `${JSON.stringify({ appearance })}\n`);
  } catch {
    // The setting still applies for this run.
  }
}

function openExternal(target: string) {
  if (/^https?:\/\//i.test(target)) shell.openExternal(target).catch(() => {});
}
