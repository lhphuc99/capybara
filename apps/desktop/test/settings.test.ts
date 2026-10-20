import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, parseSettings, settingsMenu, togglePort } from '../src/settings.js';

describe('desktop settings', () => {
  it('reads what was saved, and takes the default for what is missing or wrong', () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('not json')).toEqual(DEFAULT_SETTINGS);
    // What 0.5.0 saved: only the appearance.
    expect(parseSettings('{"appearance":"dark"}')).toEqual({ ...DEFAULT_SETTINGS, appearance: 'dark' });
    expect(parseSettings('{"appearance":"blue","remoteUi":"yes","metro":false,"metroPorts":[8083,8081,8083,"x",70000]}')).toEqual({
      appearance: 'system',
      remoteUi: false,
      metro: false,
      metroPorts: [8081, 8083],
    });
  });

  it('turns Metro ports on and off, keeping the last one', () => {
    expect(togglePort([8081], 8083, true)).toEqual([8081, 8083]);
    expect(togglePort([8081, 8083], 8081, false)).toEqual([8083]);
    expect(togglePort([8083], 8083, false)).toEqual([8083]);
  });

  it('builds a Settings menu that changes nothing while another program runs the server', () => {
    const actions = { setRemoteUi: vi.fn(), setMetro: vi.fn(), setMetroPort: vi.fn() };
    type Item = { label?: string; enabled?: boolean; checked?: boolean; submenu?: Item[]; click?: (item: { checked: boolean }) => void };
    const items = (menu: unknown) => (menu as { submenu: Item[] }).submenu.filter((item) => item.label);
    const mine = items(settingsMenu({ settings: DEFAULT_SETTINGS, ownServer: true, remoteUiFromEnv: false }, actions));
    expect(mine.map((item) => [item.label, item.enabled, item.checked])).toEqual([
      ['Let Other Devices Open the UI', true, false],
      ['Read React Native Apps Through Metro', true, true],
      ['Metro Ports', true, undefined],
    ]);
    expect(mine[2]!.submenu!.map((port) => [port.label, port.checked])).toEqual([
      ['8081', true],
      ['8082', true],
      ['8083', false],
      ['8084', false],
      ['8085', false],
    ]);
    mine[2]!.submenu![2]!.click!({ checked: true });
    expect(actions.setMetroPort).toHaveBeenCalledWith(8083, true);

    const theirs = items(settingsMenu({ settings: DEFAULT_SETTINGS, ownServer: false, remoteUiFromEnv: true }, actions));
    expect(theirs.map((item) => [item.label, item.enabled])).toEqual([
      ['Showing the Capybara server of another program', false],
      ['Let Other Devices Open the UI (CAPYBARA_REMOTE_UI)', false],
      ['Read React Native Apps Through Metro', false],
      ['Metro Ports', false],
    ]);
  });
});
