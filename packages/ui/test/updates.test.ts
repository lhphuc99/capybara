import type { ServerInfo, SessionInfo } from '@capybara-devtools/protocol';
import { describe, expect, it } from 'vitest';
import { updateNotice } from '../src/updates';

const server = (latest?: Record<string, string>, version = '0.2.0'): ServerInfo => ({ version, port: 7357, addresses: [], latest });
const app = (name: string, version: string): SessionInfo => ({
  id: 's1',
  appName: 'Shop',
  platform: 'web',
  sdk: { name, version },
  startedAt: 1,
});
const none = new Set<string>();

describe('updateNotice', () => {
  it('asks to update an SDK older than the one on npm', () => {
    expect(updateNotice(server({ '@capybara-devtools/web': '0.3.0' }), app('@capybara-devtools/web', '0.2.0'), false, none)).toEqual({
      key: '@capybara-devtools/web@0.3.0',
      text: 'Shop uses @capybara-devtools/web 0.2.0. Version 0.3.0 is out:',
      command: 'npm install @capybara-devtools/web@0.3.0',
    });
  });

  it('falls back to the server version without an npm lookup', () => {
    const notice = updateNotice(server(undefined, '0.2.0'), app('@capybara-devtools/react-native', '0.1.0'), true, none);
    expect(notice?.command).toBe('npm install @capybara-devtools/react-native@0.2.0');
  });

  it('says nothing about up-to-date SDKs, Metro sessions or other SDK names', () => {
    expect(updateNotice(server({ '@capybara-devtools/web': '0.2.0' }), app('@capybara-devtools/web', '0.2.0'), false, none)).toBeUndefined();
    expect(updateNotice(server(), app('metro', '0.1.0'), false, none)).toBeUndefined();
    expect(updateNotice(server(), app('test', '0'), false, none)).toBeUndefined();
  });

  it('asks to update the Flutter package with flutter pub add, from pub.dev only', () => {
    const app = (version: string): SessionInfo => ({ id: 's1', appName: 'Shop', platform: 'ios', sdk: { name: 'capybara_devtools', version }, startedAt: 1 });
    expect(updateNotice(server({ capybara_devtools: '0.2.0' }), app('0.1.0'), false, none)?.command).toBe('flutter pub add capybara_devtools:^0.2.0');
    // Its versions are its own: the server's says nothing about it.
    expect(updateNotice(server(undefined, '0.9.0'), app('0.1.0'), false, none)).toBeUndefined();
  });

  it('offers a newer CLI, but not in the desktop app', () => {
    const latest = server({ 'capybara-devtools': '0.3.0' });
    expect(updateNotice(latest, undefined, false, none)?.command).toBe('npx capybara-devtools@latest');
    expect(updateNotice(latest, undefined, true, none)).toBeUndefined();
  });

  it('skips dismissed notices until a newer version comes out', () => {
    const latest = server({ '@capybara-devtools/web': '0.3.0', 'capybara-devtools': '0.3.0' });
    const session = app('@capybara-devtools/web', '0.2.0');
    expect(updateNotice(latest, session, false, new Set(['@capybara-devtools/web@0.3.0']))?.key).toBe('capybara-devtools@0.3.0');
    expect(updateNotice(server({ '@capybara-devtools/web': '0.4.0' }), session, true, new Set(['@capybara-devtools/web@0.3.0']))?.key).toBe(
      '@capybara-devtools/web@0.4.0',
    );
  });
});
