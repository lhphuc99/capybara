import type { SessionMeta, StateEntrySummary, StateStoreInfo } from '@capybara-devtools/protocol';
import { describe, expect, it } from 'vitest';
import type { ChangeEntry, StoreEntry } from '../src/mcp-history.js';
import { entryLine, filterEntries } from '../src/mcp-queries.js';
import { redactor } from '../src/mcp-redact.js';
import { changeLines, listStores, noStoresText, readValueText } from '../src/mcp-state.js';
import { storageValueText } from '../src/mcp-storage.js';

const entry = (key: string, extra: Partial<StateEntrySummary>): StateEntrySummary => ({
  key,
  label: key,
  kind: 'query',
  status: 'success',
  fetching: false,
  ...extra,
});

describe('state entries in MCP', () => {
  it('only calls loaded data stale or invalidated', () => {
    const failed = entry('["user",1]', { status: 'error', invalidated: true, stale: true, error: 'Request failed with status 404' });
    const stale = entry('["users"]', { stale: true });
    expect(entryLine(failed, redactor(true))).not.toMatch(/invalidated|stale/);
    expect(entryLine(stale, redactor(true))).toContain('success, stale');
    expect(filterEntries([failed, stale], { status: 'stale' }).map((item) => item.key)).toEqual(['["users"]']);
  });

  it('hides credentials that only their shape gives away', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMDQyIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
    const keyed = entry(`["/api/user","${jwt}"]`, { status: 'error', error: 'Bearer abcdefgh12345678 was rejected' });
    const line = entryLine(keyed, redactor(true));
    expect(line).not.toContain(jwt);
    expect(line).not.toContain('abcdefgh12345678');
    expect(line).toContain('["/api/user","[hidden]"]');
    expect(entryLine(keyed, redactor(false))).toContain(jwt);
  });
});

describe('state changes in MCP', () => {
  it('leaves out an action payload that is undefined', () => {
    const info: StateStoreInfo = { id: 'redux:1', library: 'redux', label: 'shop', via: 'shim', actions: true };
    const change: ChangeEntry = {
      seq: 7,
      ts: Date.UTC(2026, 9, 18, 14, 2, 11),
      store: 'redux:1',
      rev: 3,
      cause: 'action',
      action: { type: 'cart/clear', payload: { payload: { $t: 'undefined' } } },
      ops: [],
      opCount: 0,
      skipped: 0,
      missed: 0,
    };
    const [head] = changeLines(change, info, redactor(true), false);
    expect(head).toMatch(/cart\/clear$/);
  });
});

describe('credentials in MCP', () => {
  it('shows a credential that is not set, so a signed-out app reads differently from a signed-in one', () => {
    const redact = redactor(true);
    expect(redact.json({ token: null, refreshToken: '', apiKey: false, password: 'hunter2', session: { jwt: 'eyJ.e30.c2ln' } })).toEqual({
      token: null, refreshToken: '', apiKey: false, password: '[hidden]', session: { jwt: '[hidden]' },
    });
    expect(redact.value({ user: { name: 'Ada', token: { $t: 'undefined' } }, accessToken: 'abc123' })).toEqual({
      user: { name: 'Ada', token: { $t: 'undefined' } }, accessToken: '[hidden]',
    });
    expect(redact.headers({ Authorization: '', Cookie: 'sid=1' })).toEqual({ Authorization: '', Cookie: '[hidden]' });
    expect(redact.url('ws://api.test/socket?token=&page=2')).toBe('ws://api.test/socket?token=&page=2');
    expect(redact.url('ws://api.test/socket?token=t1&page=2')).toBe('ws://api.test/socket?token=[hidden]&page=2');
    expect(storageValueText('authToken', '', redact, false)).toBe('');
    expect(storageValueText('authToken', 'abc123', redact, false)).toBe('[hidden]');
    expect(readValueText({ value: null, truncated: false }, ['user', 'token'], redact, 1_000)).toBe('null');
    expect(readValueText({ value: 'abc123', truncated: false }, ['user', 'token'], redact, 1_000)).toBe('[hidden]');
  });

  it('shows signing out in state changes', () => {
    const info: StateStoreInfo = { id: 'redux:1', library: 'redux', label: 'shop', via: 'shim', actions: true };
    const change: ChangeEntry = {
      seq: 8,
      ts: Date.UTC(2026, 9, 18, 14, 2, 12),
      store: 'redux:1',
      rev: 4,
      cause: 'action',
      action: { type: 'auth/setToken', payload: { payload: null } },
      ops: [{ op: 'set', path: ['user', 'token'], prev: 'abc123', value: null }],
      opCount: 1,
      skipped: 0,
      missed: 0,
    };
    const [head, op] = changeLines(change, info, redactor(true), false);
    expect(head).toMatch(/ auth\/setToken \{"payload":null\}$/);
    expect(op).toBe('    ~ user.token "[hidden]" → null');
  });
});

describe('state stores in MCP', () => {
  it('names every library the State tab shows when an app has no stores to read', () => {
    const session: SessionMeta = {
      info: { id: 'metro-1', appName: 'Shop', platform: 'ios', sdk: { name: 'metro', version: '0.3.0' }, startedAt: 0 },
      connected: true,
      lastSeen: 0,
      eventCount: 0,
    };
    expect(noStoresText(session)).toContain('but not Redux, Zustand, TanStack Query, SWR or React Context state.');
  });

  it('lists the newest of same-named stores and leaves out library contexts', () => {
    const store = (id: string, label: string, extra: Partial<StateStoreInfo> = {}): StoreEntry => ({
      info: { id, library: id.split(':')[0] as StateStoreInfo['library'], label, via: 'shim', actions: true, ...extra },
      changes: 0,
    });
    const list = listStores([
      store('zustand:1', 'ui'),
      store('zustand:2', 'ui', { disposed: true }),
      store('zustand:3', 'ui'),
      store('context:1', 'Theme'),
      store('context:2', 'ReactReduxContext', { vendor: 'react-redux' }),
      store('context:3', 'Theme'),
    ]);
    expect(list.shown.map((entry) => entry.info.id)).toEqual(['zustand:3', 'context:1', 'context:3']);
    expect(list.replaced).toBe(2);
    expect(list.vendored).toBe(1);
  });
});
