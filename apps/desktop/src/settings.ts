import type { MenuItemConstructorOptions } from 'electron';

export const APPEARANCES = ['system', 'light', 'dark'] as const;
export type Appearance = (typeof APPEARANCES)[number];

/** Ports Expo and React Native's Metro use: 8081, then the next free one when several projects run. */
export const METRO_PORT_CHOICES = [8081, 8082, 8083, 8084, 8085];

/** What the app remembers in settings.json between launches. */
export interface DesktopSettings {
  appearance: Appearance;
  remoteUi: boolean;
  /** Read React Native apps without the SDK through Metro. */
  metro: boolean;
  metroPorts: number[];
  /** Read Flutter apps started with flutter run through the Dart VM service. */
  flutter: boolean;
}

export const DEFAULT_SETTINGS: DesktopSettings = {
  appearance: 'system',
  remoteUi: false,
  metro: true,
  metroPorts: [8081, 8082],
  flutter: true,
};

export function isAppearance(value: unknown): value is Appearance {
  return APPEARANCES.includes(value as Appearance);
}

/** The settings in a settings.json, each unreadable or missing one at its default. */
export function parseSettings(text: string | undefined): DesktopSettings {
  let saved: Record<string, unknown> = {};
  try {
    const parsed: unknown = text === undefined ? {} : JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed as Record<string, unknown>;
  } catch {
    // A file another version wrote badly starts over from the defaults.
  }
  const ports = Array.isArray(saved.metroPorts)
    ? saved.metroPorts.filter((port): port is number => Number.isInteger(port) && port > 0 && port <= 65_535)
    : [];
  return {
    appearance: isAppearance(saved.appearance) ? saved.appearance : DEFAULT_SETTINGS.appearance,
    remoteUi: saved.remoteUi === true,
    metro: saved.metro !== false,
    metroPorts: ports.length > 0 ? [...new Set(ports)].sort((a, b) => a - b) : DEFAULT_SETTINGS.metroPorts,
    flutter: saved.flutter !== false,
  };
}

/** `ports` with `port` turned on or off; the last port stays, since reading Metro has its own switch. */
export function togglePort(ports: number[], port: number, on: boolean): number[] {
  const next = on ? [...new Set([...ports, port])] : ports.filter((other) => other !== port);
  return next.length > 0 ? next.sort((a, b) => a - b) : ports;
}

export interface SettingsMenuState {
  settings: DesktopSettings;
  /** False while the app shows the server of another program, such as `npx capybara-devtools`. */
  ownServer: boolean;
  /** CAPYBARA_REMOTE_UI=1 turns remote UI on for this run, whatever the setting. */
  remoteUiFromEnv: boolean;
}

export interface SettingsMenuActions {
  setRemoteUi(on: boolean): void;
  setMetro(on: boolean): void;
  setMetroPort(port: number, on: boolean): void;
  setFlutter(on: boolean): void;
}

export function settingsMenu({ settings, ownServer, remoteUiFromEnv }: SettingsMenuState, actions: SettingsMenuActions): MenuItemConstructorOptions {
  const note: MenuItemConstructorOptions[] = ownServer
    ? []
    : [{ label: 'Showing the Capybara server of another program', enabled: false }, { type: 'separator' }];
  return {
    label: 'Settings',
    submenu: [
      ...note,
      {
        label: remoteUiFromEnv ? 'Let Other Devices Open the UI (CAPYBARA_REMOTE_UI)' : 'Let Other Devices Open the UI',
        type: 'checkbox',
        checked: remoteUiFromEnv || settings.remoteUi,
        enabled: ownServer && !remoteUiFromEnv,
        click: (item) => actions.setRemoteUi(item.checked),
      },
      { type: 'separator' },
      {
        label: 'Read React Native Apps Through Metro',
        type: 'checkbox',
        checked: settings.metro,
        enabled: ownServer,
        click: (item) => actions.setMetro(item.checked),
      },
      {
        label: 'Metro Ports',
        enabled: ownServer && settings.metro,
        submenu: METRO_PORT_CHOICES.map((port) => ({
          label: String(port),
          type: 'checkbox' as const,
          checked: settings.metroPorts.includes(port),
          click: (item: { checked: boolean }) => actions.setMetroPort(port, item.checked),
        })),
      },
      {
        label: 'Read Flutter Apps Through the Dart VM Service',
        type: 'checkbox',
        checked: settings.flutter,
        enabled: ownServer,
        click: (item) => actions.setFlutter(item.checked),
      },
    ],
  };
}
