import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PORT } from '@capybara-devtools/protocol';
import {
  fetchLatestVersions,
  listen,
  PortInUseError,
  readPort,
  remoteUiFrom,
  reverseAndroidPorts,
  startFlutterBridge,
  startMetroBridge,
  startOrReuse,
  updateCheckFrom,
  type CapybaraServer,
  type FlutterBridge,
  type MetroBridge,
  type ServerOptions,
  type Started,
} from 'capybara-devtools';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron';
import { DEFAULT_SETTINGS, isAppearance, parseSettings, settingsMenu, togglePort, type DesktopSettings } from './settings.js';
import { checkForUpdates, startUpdateChecks } from './updater.js';

const TAKEOVER_INTERVAL_MS = 2_000;

let url = '';
let mainWindow: BrowserWindow | null = null;
let metroBridge: MetroBridge | undefined;
let flutterBridge: FlutterBridge | undefined;
let takeoverTimer: ReturnType<typeof setTimeout> | undefined;
let quitting = false;
let settings: DesktopSettings = DEFAULT_SETTINGS;
/** The server this app runs; none while it shows the server of another program. */
let own: { server: CapybaraServer; port: number } | undefined;
const remoteUiFromEnv = remoteUiFrom(process.env);

app.on('before-quit', () => {
  quitting = true;
  clearTimeout(takeoverTimer);
  metroBridge?.stop();
  flutterBridge?.stop();
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
  settings = readSettings();
  // The UI owns the Appearance setting; keeping a copy here gives the window the right colors before it loads.
  nativeTheme.themeSource = settings.appearance;
  nativeTheme.on('updated', () => mainWindow?.setBackgroundColor(windowBackground()));
  ipcMain.on('appearance', (event, value: unknown) => {
    if (event.sender !== mainWindow?.webContents || !isAppearance(value) || value === nativeTheme.themeSource) return;
    nativeTheme.themeSource = value;
    saveSettings({ appearance: value });
  });
  buildMenu();

  const port = readPort(process.env.CAPYBARA_PORT, true);
  if (port === undefined) {
    // Otherwise listening fails with a RangeError, and Try Again fails the same way.
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      message: 'CAPYBARA_PORT is not a port',
      detail:
        `It is set to "${process.env.CAPYBARA_PORT}"; a port is a whole number up to 65535. ` +
        `Capybara can use port ${DEFAULT_PORT} instead, but apps set to another port will not reach it.`,
      buttons: [`Use ${DEFAULT_PORT}`, 'Quit'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 1) {
      app.quit();
      return;
    }
  }
  const checkUpdates = updateCheckFrom(process.env);
  const options: ServerOptions = {
    port: port ?? DEFAULT_PORT,
    uiDir: join(app.getAppPath(), 'dist', 'ui'),
    remoteUi: remoteUiFromEnv || settings.remoteUi,
    onHint: (hint) => console.log(hint),
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
    own = { server: started.server, port: started.port };
    restartMetro();
    restartFlutter();
    buildMenu();
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
    const taken = await listen(options).catch(() => null);
    if (quitting) {
      await taken?.server.close();
      return;
    }
    if (!taken) {
      takeOverWhenFree(options);
      return;
    }
    console.log(`Took over port ${taken.port}`);
    reverseAndroidPorts(taken.port, findAdb());
    own = taken;
    restartMetro();
    restartFlutter();
    buildMenu();
    // The page came from the other server, which may be a different version.
    if (mainWindow) load(mainWindow);
  }, TAKEOVER_INTERVAL_MS);
}

/** Reads apps through Metro on the ports in the settings, or stops reading them. */
function restartMetro() {
  metroBridge?.stop();
  metroBridge = undefined;
  if (!own || !settings.metro) return;
  const { server, port } = own;
  metroBridge = startMetroBridge({ port, metroPorts: settings.metroPorts, version: app.getVersion(), onHint: (hint) => server.hint(hint) });
}

/** Reads Flutter apps through the Dart VM service, or stops reading them. */
function restartFlutter() {
  flutterBridge?.stop();
  flutterBridge = undefined;
  own?.server.setFlutterAttach(undefined);
  if (!own || !settings.flutter) return;
  const { server, port } = own;
  flutterBridge = startFlutterBridge({ port, version: app.getVersion(), onHint: (hint) => server.hint(hint) });
  server.setFlutterAttach(flutterBridge.attach);
}

async function setRemoteUi(on: boolean) {
  if (on) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      message: 'Let other devices open Capybara?',
      detail:
        'Phones, tablets and other computers on your network can then open the UI, and read it with capybara mcp. ' +
        'They see everything your apps send, tokens included.',
      buttons: ['Let Them In', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) {
      // The menu ticked the box already.
      buildMenu();
      return;
    }
  }
  saveSettings({ remoteUi: on });
  own?.server.setRemoteUi(on);
  buildMenu();
}

function buildMenu() {
  const updates: MenuItemConstructorOptions[] = app.isPackaged
    ? [{ label: 'Check for Updates…', click: () => void checkForUpdates(() => mainWindow, true) }]
    : [];
  const options = settingsMenu(
    { settings, ownServer: own !== undefined, remoteUiFromEnv },
    {
      setRemoteUi: (on) => void setRemoteUi(on),
      setMetro: (on) => {
        saveSettings({ metro: on });
        restartMetro();
        buildMenu();
      },
      setMetroPort: (port, on) => {
        saveSettings({ metroPorts: togglePort(settings.metroPorts, port, on) });
        restartMetro();
        buildMenu();
      },
      setFlutter: (on) => {
        saveSettings({ flutter: on });
        restartFlutter();
        buildMenu();
      },
    },
  );
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
              options,
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
        : { label: 'File', submenu: [options, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      ...(process.platform !== 'darwin' && updates.length > 0 ? [{ label: 'Help', submenu: updates }] : []),
    ]),
  );
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

const settingsFile = () => join(app.getPath('userData'), 'settings.json');

function readSettings(): DesktopSettings {
  try {
    return parseSettings(readFileSync(settingsFile(), 'utf8'));
  } catch {
    return parseSettings(undefined);
  }
}

function saveSettings(change: Partial<DesktopSettings>) {
  settings = { ...settings, ...change };
  try {
    writeFileSync(settingsFile(), `${JSON.stringify(settings)}\n`);
  } catch {
    // The setting still applies for this run.
  }
}

function openExternal(target: string) {
  if (/^https?:\/\//i.test(target)) shell.openExternal(target).catch(() => {});
}
