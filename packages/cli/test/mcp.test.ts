import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ViewerConnection } from '../src/mcp-connection.js';
import { createMcpServer } from '../src/mcp.js';
import { createServer, type CapybaraServer } from '../src/server.js';

let server: CapybaraServer;
let api: http.Server;
let apiUrl = '';
let port = 0;
let app: WebSocket;
const closers: Array<() => Promise<unknown> | void> = [];

const STORAGE = [
  { key: 'user', value: '{"id":1,"name":"Ada","token":"abc123"}', size: 38, truncated: false },
  { key: 'authToken', value: 'xyz', size: 3, truncated: false },
  { key: 'theme', value: 'dark', size: 4, truncated: false },
];

const SHOP = { id: 'redux:1', library: 'redux', label: 'shop', via: 'shim', actions: true };
const UI_OLD = { id: 'zustand:1', library: 'zustand', label: 'ui', via: 'subscribe', actions: false };
const UI = { id: 'zustand:2', library: 'zustand', label: 'ui', via: 'subscribe', actions: false };
const QUERIES = { id: 'tanstack-query:1', library: 'tanstack-query', label: 'queries', via: 'client', actions: false, ops: ['refetch', 'invalidate'] };

const SHOP_STATE = {
  cart: { items: [{ id: 1, qty: 1 }, { id: 3, qty: 2 }], total: 27 },
  user: { name: 'Ada', token: 'abc123', session: { jwt: 'eyJhbGciOiJIUzI1NiJ9.e30.c2ln' } },
  catalog: { products: Array.from({ length: 60 }, (_, id) => ({ id, name: `Product ${id}`, price: id * 1.5 })) },
};

const ENTRIES = [
  { key: '["todos"]', label: '["todos"]', kind: 'query', status: 'success', fetching: false, stale: true, observers: 2, preview: 'Array(2)' },
  { key: '["me"]', label: '["me"]', kind: 'query', status: 'success', fetching: false, stale: false, observers: 1, preview: '{id, name, …}' },
  { key: '["user",7]', label: '["user",7]', kind: 'query', status: 'error', fetching: false, observers: 1, error: 'AxiosError: Request failed with status code 404' },
  { key: '1', label: 'addTodo', kind: 'mutation', status: 'success', fetching: false },
  { key: '["feed"]', label: '["feed"]', kind: 'infinite', status: 'pending', fetching: true, observers: 1 },
  { key: '["auth","token"]', label: '["auth","token"]', kind: 'query', status: 'success', fetching: false, observers: 1 },
];
const ENTRY_DATA: Record<string, unknown> = {
  '["todos"]': [{ id: 1, title: 'Buy milk' }, { id: 2, title: 'Walk the capybara' }],
  '["me"]': { id: 1, name: 'Ada', accessToken: 'zzz' },
  '["auth","token"]': 'tok-123',
  '1': { id: 3, title: 'Feed the capybara' },
};

function at(root: unknown, path: Array<string | number>): { found: boolean; value?: unknown } {
  let current = root;
  for (const key of path) {
    if (current === null || typeof current !== 'object' || !(String(key) in current)) return { found: false };
    current = (current as Record<string, unknown>)[key];
  }
  return { found: true, value: current };
}

/** What the SDK's state plugin answers, with the same errors. */
function answerState(method: string, params: { store?: string; key?: string; path?: Array<string | number> } | undefined): unknown {
  const path = params?.path ?? [];
  switch (method) {
    case 'stores':
      return [SHOP, UI, QUERIES];
    case 'get': {
      if (params?.store === UI.id) return { rev: 1, pending: false, value: { theme: 'light' }, truncated: false };
      if (params?.store !== SHOP.id) throw new Error(`Unknown store "${params?.store}"`);
      // A root read too big for one answer: the catalog comes back cut.
      if (path.length === 0) return { rev: 7, pending: true, value: { ...SHOP_STATE, catalog: { $t: 'limit', name: 'Object' } }, truncated: true };
      const found = at(SHOP_STATE, path);
      if (!found.found) throw new Error(`Nothing at ${JSON.stringify(path)}`);
      return { rev: 7, pending: false, value: found.value, truncated: false };
    }
    case 'entries':
      if (params?.store !== QUERIES.id) throw new Error(`Unknown store "${params?.store}"`);
      return { entries: ENTRIES, total: ENTRIES.length + 1 };
    case 'entry': {
      const summary = ENTRIES.find((entry) => entry.key === params?.key);
      if (!summary) return null;
      const found = at(ENTRY_DATA[summary.key], path);
      if (!found.found) throw new Error(`Nothing at ${JSON.stringify(path)}`);
      return { summary, data: found.value, truncated: false };
    }
    default:
      throw new Error(`Unknown command state.${method}`);
  }
}

beforeAll(async () => {
  // An API without CORS headers, so the diagnosis has something real to find.
  api = http.createServer((_req, res) => res.writeHead(200).end());
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}/data`;
  server = createServer({ port: 0, host: '127.0.0.1', version: 'test' });
  ({ port } = await server.start());

  app = new WebSocket(`ws://127.0.0.1:${port}/client`);
  await new Promise((resolve) => app.once('open', resolve));
  app.on('message', (data) => {
    const message = JSON.parse(String(data));
    if (message.t !== 'command') return;
    const { plugin, method, params } = message;
    if (plugin === 'state') {
      try {
        app.send(JSON.stringify({ t: 'result', id: message.id, ok: true, result: answerState(method, params) }));
      } catch (error) {
        app.send(JSON.stringify({ t: 'result', id: message.id, ok: false, error: (error as Error).message }));
      }
      return;
    }
    const result =
      method === 'list'
        ? [{ id: 'localStorage', label: 'Local Storage', readOnly: false, canClear: true }]
        : method === 'entries'
          ? { entries: STORAGE, total: STORAGE.length }
          : (STORAGE.find((entry) => entry.key === params.key) ?? null);
    app.send(JSON.stringify({ t: 'result', id: message.id, ok: true, result }));
  });
  app.send(JSON.stringify({
    t: 'hello',
    protocol: 1,
    session: {
      id: 'web-1',
      appName: 'Shop',
      platform: 'web',
      sdk: { name: 'test', version: '0' },
      startedAt: 1,
      url: 'http://localhost:6868/',
      plugins: ['console', 'network', 'storage', 'state'],
    },
  }));
  let seq = 0;
  const event = (kind: string, payload: object) => ({ seq: ++seq, ts: 1_700_000_000_000 + seq, kind, payload });
  app.send(JSON.stringify({
    t: 'events',
    events: [
      event('log', { level: 'log', source: 'console', args: ['User loaded', { id: 1, name: 'Ada', token: 'abc123' }] }),
      event('log', {
        level: 'error',
        source: 'uncaught',
        args: [{ $t: 'error', name: 'TypeError', message: 'x is undefined', stack: 'TypeError: x is undefined\n    at App (App.tsx:4:2)\n    at render (react.js:1:1)' }],
      }),
      event('log', { level: 'warn', source: 'console', args: ['Slow render %d ms', 120] }),
      event('network.request', { id: 'r1', initiator: 'fetch', method: 'GET', url: 'http://api.test/users?token=secret123&page=2', headers: { Authorization: 'Bearer abc', Accept: 'application/json' } }),
      event('network.response', {
        id: 'r1',
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json', 'set-cookie': 'sid=1' },
        body: { kind: 'text', text: '{"users":[{"id":1}],"accessToken":"zzz"}', size: 40, contentType: 'application/json' },
        duration: 12,
      }),
      event('network.request', { id: 'r2', initiator: 'xhr', method: 'POST', url: 'http://api.test/login', headers: {}, body: { kind: 'text', text: '{"email":"a@b.c","password":"hunter2"}' } }),
      event('network.response', { id: 'r2', status: 500, headers: {}, duration: 30 }),
      event('network.request', { id: 'r3', initiator: 'fetch', method: 'GET', url: apiUrl, headers: {} }),
      event('network.error', { id: 'r3', message: 'Failed to fetch', duration: 3, cause: 'cross-origin' }),
      event('ws.connect', { id: 'w1', url: 'ws://api.test/socket?token=t1' }),
      event('ws.open', { id: 'w1', duration: 4 }),
      event('ws.message', { id: 'w1', direction: 'sent', data: { kind: 'text', text: '{"type":"hello"}' } }),
      event('ws.message', { id: 'w1', direction: 'received', data: { kind: 'text', text: '{"type":"welcome","sessionToken":"s3"}' } }),
      event('ws.close', { id: 'w1', code: 1000, wasClean: true, duration: 50 }),
      event('state.store', { store: SHOP }),
      event('state.store', { store: UI_OLD }),
      event('state.store', { store: QUERIES }),
      event('state.change', { store: SHOP.id, rev: 1, cause: 'init', ops: [] }),
      event('state.change', { store: UI_OLD.id, rev: 1, cause: 'set', ops: [{ op: 'set', path: ['theme'], prev: 'light', value: 'dark' }] }),
      event('state.change', {
        store: SHOP.id,
        rev: 2,
        cause: 'action',
        action: { type: 'cart/addItem', payload: { payload: { id: 3, qty: 2 } } },
        ops: [
          { op: 'add', path: ['cart', 'items', 1], value: { id: 3, qty: 2 } },
          { op: 'set', path: ['cart', 'total'], prev: 12.5, value: 27 },
        ],
      }),
      event('state.change', {
        store: SHOP.id,
        rev: 3,
        cause: 'action',
        action: { type: 'auth/login', payload: { payload: { email: 'ada@example.com', password: 'hunter2' } } },
        ops: [
          { op: 'set', path: ['user', 'name'], prev: null, value: 'Ada' },
          { op: 'set', path: ['user', 'token'], prev: null, value: 'abc123' },
        ],
      }),
      // Hot reload: a new instance takes the label, and the old one is disposed.
      event('state.store', { store: UI }),
      event('state.store', { store: { ...UI_OLD, disposed: true } }),
      event('state.change', { store: UI.id, rev: 1, cause: 'set', ops: [{ op: 'set', path: ['theme'], prev: 'dark', value: 'light' }] }),
      event('state.change', {
        store: SHOP.id,
        rev: 4,
        cause: 'action',
        action: { type: 'auth/setToken', payload: { payload: 'eyJhbGciOiJIUzI1NiJ9.e30.c2ln' } },
        ops: [{ op: 'set', path: ['user', 'session', 'jwt'], prev: 'old-jwt', value: 'eyJhbGciOiJIUzI1NiJ9.e30.c2ln' }],
        skipped: 12,
      }),
      event('state.change', {
        store: SHOP.id,
        rev: 7,
        cause: 'action',
        action: { type: 'cart/clear' },
        ops: [
          { op: 'del', path: ['cart', 'items', 0], prev: { id: 1, qty: 1 } },
          { op: 'del', path: ['cart', 'items', 1], prev: { id: 3, qty: 2 } },
          { op: 'set', path: ['cart', 'total'], prev: 27, value: 0 },
          { op: 'set', path: ['cart', 'updatedAt'], prev: '2026-10-18T14:02:11.384Z', value: '2026-10-18T14:02:14.420Z' },
        ],
        opCount: 140,
      }),
      event('state.entries', { store: QUERIES.id, upserts: ENTRIES, removed: [], reset: true }),
    ],
  }));
});

afterAll(async () => {
  for (const close of closers.splice(0)) await close();
  app.terminate();
  await server.close();
  await new Promise((resolve) => api.close(resolve));
});

async function connect(options: { showSecrets?: boolean; port?: number } = {}) {
  const connection = new ViewerConnection(options.port ?? port);
  const mcp = createMcpServer(connection, { version: 'test', showSecrets: options.showSecrets });
  const client = new Client({ name: 'test', version: '0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientSide), mcp.connect(serverSide)]);
  closers.push(() => client.close(), () => connection.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: result.content[0]!.text, isError: result.isError === true };
  };
  return { client, call };
}

/** Waits until the server has the app's events, then reads with every tool through one client. */
async function ready() {
  const mcp = await connect();
  for (let i = 0; i < 50; i++) {
    if ((await mcp.call('get_network')).text.includes('w1')) return mcp;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('The app events never arrived');
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for the server');
}

/** Another app, connected with `hello` and `events`. */
async function otherApp(session: object, events: object[] = []) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/client`);
  await new Promise((resolve) => socket.once('open', resolve));
  socket.send(JSON.stringify({ t: 'hello', protocol: 1, session }));
  if (events.length > 0) socket.send(JSON.stringify({ t: 'events', events }));
  return socket;
}

describe('capybara mcp', () => {
  it('describes its tools and the session it reads', async () => {
    const { client, call } = await ready();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'diagnose_request',
      'get_logs',
      'get_network',
      'get_queries',
      'get_request',
      'get_setup_guide',
      'get_state',
      'get_state_actions',
      'get_storage',
      'get_websocket',
      'list_sessions',
    ]);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
    expect(client.getInstructions()).toContain('get_state_actions');
    expect(client.getInstructions()).toContain('get_setup_guide');
    const sessions = await call('list_sessions');
    expect(sessions.text).toContain('Capybara test on port');
    expect(sessions.text).toContain('- web-1: Shop (web, localhost:6868) · connected');
  });

  it('lists what Capybara noticed with the apps, such as one Metro cannot read', async () => {
    const { call } = await connect();
    const hint = "Expo Go on Android (Pixel 9) can't be read through Metro: its JavaScript engine does not support debugging.";
    server.hint(hint);
    const { text } = await until(() => call('list_sessions'), (result) => result.text.includes('Capybara noticed:'));
    expect(text).toContain(`- web-1: Shop (web, localhost:6868) · connected`);
    expect(text).toContain(`Capybara noticed:\n- ${hint}`);
  });

  it('reads a session whose history comes in parts', async () => {
    const body = 'x'.repeat(128 * 1024);
    const events = Array.from({ length: 40 }, (_, i) => [
      { seq: 2 * i + 1, ts: 1_700_000_000_000 + i, kind: 'network.request', payload: { id: `b${i}`, initiator: 'fetch', method: 'GET', url: `https://api.test/big/${i}`, headers: {} } },
      { seq: 2 * i + 2, ts: 1_700_000_000_000 + i, kind: 'network.response', payload: { id: `b${i}`, status: 200, headers: {}, body: { kind: 'text', text: body }, duration: 1 } },
    ]).flat();
    const big = await otherApp({ id: 'web-big', appName: 'Big', platform: 'web', sdk: { name: 'test', version: '0' }, startedAt: 3 }, events);
    try {
      const { call } = await connect();
      const { text } = await until(() => call('get_network', { session: 'web-big' }), (result) => result.text.includes('40 of 40'));
      expect(text).toContain('https://api.test/big/39');
    } finally {
      // Connected, it would be the newest app the other tests read by default.
      big.close();
    }
  });

  it('filters logs by level, text, regex and seq, and hides credentials in their values', async () => {
    const { call } = await ready();
    const all = (await call('get_logs')).text;
    expect(all).toContain('Shop (session web-1): 3 of 3 log entries match.');
    expect(all).toMatch(/#1 \S+ LOG   User loaded \{id: 1, name: "Ada", token: "\[hidden\]"\}/);
    expect(all).toMatch(/#2 \S+ ERROR \(uncaught\) TypeError: x is undefined\n {4}at App \(App\.tsx:4:2\)/);
    expect(all).not.toContain('abc123');
    expect((await call('get_logs', { level: ['warn'] })).text).toMatch(/1 of 3 log entries match\.\n#3 \S+ WARN  Slow render 120 ms/);
    expect((await call('get_logs', { search: '/typeerror/i' })).text).toContain('1 of 3');
    expect((await call('get_logs', { after: 2 })).text).toContain('#3 ');
    expect((await call('get_logs', { limit: 1 })).text).toContain('Showing the newest 1; pass before: 3 for older ones.');
    const full = (await call('get_logs', { seq: 1 })).text;
    expect(full).toContain('"token": "[hidden]"');
    expect((await call('get_logs', { search: '/[/' })).isError).toBe(true);
  });

  it('lists requests one per line and filters them by status, errors and type', async () => {
    const { call } = await ready();
    const all = (await call('get_network')).text;
    expect(all).toContain('4 of 4 requests match.');
    expect(all).toContain('http://api.test/users?token=[hidden]&page=2');
    expect(all).toContain('ws://api.test/socket?token=[hidden]');
    expect(all).toMatch(/r3 .* failed .*← Failed to fetch \[cross-origin\]/);
    const lines = (text: string) => text.split('\n').slice(2).map((line) => line.split(' ')[0]);
    expect(lines((await call('get_network', { status: '5xx' })).text)).toEqual(['r2']);
    expect(lines((await call('get_network', { errors: true })).text)).toEqual(['r2', 'r3']);
    expect(lines((await call('get_network', { type: 'websocket' })).text)).toEqual(['w1']);
    expect(lines((await call('get_network', { method: 'post' })).text)).toEqual(['r2']);
    expect((await call('get_network', { status: 'teapot' })).isError).toBe(true);
  });

  it('reads one request with its headers and bodies, credentials hidden', async () => {
    const { call } = await ready();
    const users = (await call('get_request', { id: 'r1' })).text;
    expect(users).toContain('Status: 200 OK · 12 ms · fetch');
    expect(users).toContain('  Authorization: [hidden]');
    expect(users).toContain('  Accept: application/json');
    expect(users).toContain('  set-cookie: [hidden]');
    expect(users).toContain('"accessToken": "[hidden]"');
    expect(users).not.toMatch(/Bearer|zzz|sid=1|secret123/);
    expect((await call('get_request', { id: 'r2' })).text).toContain('"password": "[hidden]"');
    const failed = (await call('get_request', { id: 'r3' })).text;
    expect(failed).toContain('Failed: Failed to fetch (cross-origin).');
    expect(failed).toContain('Call diagnose_request with this id');
    expect((await call('get_request', { id: 'nope' })).isError).toBe(true);
  });

  it('diagnoses a failed request through the server', async () => {
    const { call } = await ready();
    const diagnosis = (await call('diagnose_request', { id: 'r3' })).text;
    expect(diagnosis).toContain('Verdict: cors. The response (200 OK) has no Access-Control-Allow-Origin header');
    expect(diagnosis).toContain(`  GET ${apiUrl}`);
  });

  it('reads WebSocket messages', async () => {
    const { call } = await ready();
    const socket = (await call('get_websocket', { id: 'w1' })).text;
    expect(socket).toContain('2 of 2 messages match.');
    expect(socket).toMatch(/→ sent {5}\{"type":"hello"\}/);
    expect(socket).toContain('"sessionToken":"[hidden]"');
    expect((await call('get_websocket', { id: 'w1', direction: 'received' })).text).toContain('1 of 2');
    expect((await call('get_websocket', { id: 'r1' })).isError).toBe(true);
  });

  it('reads storage through the app, hiding keys and values that look like credentials', async () => {
    const { call } = await ready();
    expect((await call('get_storage')).text).toContain('- localStorage: Local Storage (3 keys)');
    const listing = (await call('get_storage', { adapter: 'localStorage' })).text;
    expect(listing).toContain('3 of 3 keys match.');
    expect(listing).toContain('- user (38 B): {"id":1,"name":"Ada","token":"[hidden]"}');
    expect(listing).toContain('- authToken (3 B): [hidden]');
    expect((await call('get_storage', { adapter: 'localStorage', search: 'dark' })).text).toContain('1 of 3');
    expect((await call('get_storage', { adapter: 'localStorage', key: 'user' })).text).toContain('  "name": "Ada",');
  });

  it('lists state stores, and reads one by id or label with credentials hidden', async () => {
    const { call } = await ready();
    const list = (await call('get_state')).text;
    expect(list).toContain('Shop (session web-1) state stores:');
    expect(list).toMatch(/\n- redux:1: shop \(Redux\) · 5 actions recorded, the last #\d+ cart\/clear at \S+ \(rev 7\)\n/);
    expect(list).toMatch(/\n- zustand:2: ui \(Zustand\) · 1 change recorded, the last #\d+ theme at /);
    expect(list).toContain('\n- tanstack-query:1: queries (TanStack Query) · 5 queries, 1 mutation (7 in the app) · 1 in error · 1 fetching\n');
    // The instance hot reloading replaced is left out, as in the UI.
    expect(list).not.toContain('zustand:1');
    expect(list).toContain('1 older store replaced by a newer one of the same name not listed.');

    const shop = (await call('get_state', { store: 'shop' })).text;
    expect(shop).toMatch(/^Shop \(session web-1\) · shop \(Redux, redux:1\)\nCurrent state as of rev 7 \(#\d+ cart\/clear at \S+\), with newer changes on the way:\n\{/);
    expect(shop).toContain('"token": "[hidden]"');
    expect(shop).toContain('"jwt": "[hidden]"');
    expect(shop).not.toMatch(/abc123|eyJ/);
    expect(shop).toContain('"catalog": "[Object]"');
    expect(shop).toContain('so the app cut some branches, shown as "[Object]" or "[Array(n)]". Read one with path, e.g. "catalog".');
    expect((await call('get_state', { store: 'redux:1', path: 'cart.items[1]' })).text).toMatch(
      /\nValue at cart\.items\[1\] as of rev 7 \(#\d+ cart\/clear at \S+\):\n\{\n {2}"id": 3,\n {2}"qty": 2\n\}$/,
    );
    // A path through a credential's key reads it hidden, too.
    expect((await call('get_state', { store: 'shop', path: 'user.token' })).text).toMatch(/:\n\[hidden\]$/);
    expect((await call('get_state', { store: 'UI' })).text).toContain('Shop (session web-1) · ui (Zustand, zustand:2)\nCurrent state as of rev 1');

    const products = (await call('get_state', { store: 'shop', path: 'catalog.products', maxChars: 1000 })).text;
    expect(products).toMatch(/"name": "Produ… \([\d,]+ more characters\)\n/);
    expect(products).toContain('Read items one at a time with path, from catalog.products[0] to catalog.products[59], or pass a larger maxChars.');
  });

  it('says why get_state cannot read a store', async () => {
    const { call } = await ready();
    const unknown = await call('get_state', { store: 'nope' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('There is no store "nope" in Shop (session web-1). Its stores:\n- redux:1: shop (Redux) · ');
    expect((await call('get_state', { store: 'queries' })).text).toBe(
      'queries (TanStack Query, tanstack-query:1) is a TanStack Query cache; get_queries reads its entries.',
    );
    expect((await call('get_state', { store: 'zustand:1' })).text).toBe(
      'The app no longer has ui (Zustand, zustand:1, disposed), so its state cannot be read. get_state_actions still reads its changes.',
    );
    const missing = await call('get_state', { store: 'shop', path: 'cart.nope' });
    expect(missing).toEqual({ isError: true, text: 'shop (Redux, redux:1) has nothing at cart.nope. Leave out path to read the whole state.' });
    expect((await call('get_state', { store: 'shop', path: 'cart..x' })).text).toContain('Could not read the path "cart..x".');
    expect((await call('get_state', { path: 'cart' })).isError).toBe(true);
  });

  it("lists state changes the way the UI's timeline shows them, credentials hidden", async () => {
    const { call } = await ready();
    const all = (await call('get_state_actions')).text;
    expect(all).toContain('Shop (session web-1): 7 of 7 changes match.');
    expect(all).toMatch(/\n#\d+ \S+ shop · initial state\n#\d+ \S+ ui · theme\n {4}~ theme "light" → "dark"\n/);
    // `payload` is the rest of the action, so it shows spread: {payload: …}, not {payload: {payload: …}}.
    expect(all).toMatch(/\n#\d+ \S+ shop · cart\/addItem \{"payload":\{"id":3,"qty":2\}\}\n {4}\+ cart\.items\[1\] = \{id: 3, qty: 2\}\n {4}~ cart\.total 12\.5 → 27\n/);
    expect(all).toContain('auth/login {"payload":{"email":"ada@example.com","password":"[hidden]"}}');
    // Signing in: the token that was not set shows as it was.
    expect(all).toContain('\n    ~ user.token null → "[hidden]"\n');
    // A token that is the whole payload is hidden by the action's name.
    expect(all).toMatch(/\n\(12 actions skipped · folded into the next one\)\n#\d+ \S+ shop · auth\/setToken \{"payload":"\[hidden\]"\}\n {4}~ user\.session\.jwt "\[hidden\]" → "\[hidden\]"\n/);
    expect(all).toMatch(/\n\(2 changes missed\)\n#\d+ \S+ shop · cart\/clear\n {4}− cart\.items\[0\] \{id: 1, qty: 1\}\n {4}− cart\.items\[1\] \{id: 3, qty: 2\}\n {4}~ cart\.total 27 → 0\n {4}… 137 more; pass seq: \d+ to read them\n/);
    expect(all).not.toMatch(/hunter2|abc123|eyJ|old-jwt/);
  });

  it('filters and pages through state changes, and reads one change in full', async () => {
    const { call } = await ready();
    expect((await call('get_state_actions', { store: 'ui' })).text).toMatch(
      /^Shop \(session web-1\) · ui \(Zustand, zustand:2\): 1 of 1 changes match\.\n#\d+ \S+ theme\n {4}~ theme "dark" → "light"\n/,
    );
    expect((await call('get_state_actions', { store: 'zustand:1' })).text).toContain('~ theme "light" → "dark"');
    expect((await call('get_state_actions', { search: 'cart.items' })).text).toContain('2 of 7 changes match.');
    expect((await call('get_state_actions', { search: '/^auth\\//' })).text).toContain('2 of 7 changes match.');
    expect((await call('get_state_actions', { search: '/[/' })).isError).toBe(true);

    const newest = (await call('get_state_actions', { store: 'shop', limit: 2 })).text;
    expect(newest).toContain('5 of 5 actions match.');
    const before = Number(/Showing the newest 2; pass before: (\d+) for older ones\./.exec(newest)?.[1]);
    const older = (await call('get_state_actions', { store: 'shop', before })).text;
    expect(older).toContain('3 of 5 actions match.');
    expect(older).toContain('cart/addItem');
    expect(older).not.toContain('cart/clear');
    expect((await call('get_state_actions', { store: 'shop', after: before })).text).toMatch(/1 of 5 actions match\.\n\(2 changes missed\)\n#\d+ \S+ cart\/clear/);

    const seq = Number(/#(\d+) \S+ cart\/clear/.exec(newest)?.[1]);
    const full = (await call('get_state_actions', { seq })).text;
    expect(full).toMatch(new RegExp(`^Shop \\(session web-1\\) · shop \\(Redux, redux:1\\)\\n#${seq} \\S+ cart/clear · rev 7\\n2 changes before this one never arrived`));
    expect(full).toContain('Action:\n    {\n      "type": "cart/clear"\n    }\n140 changes (+ added, ~ changed, − removed):\n');
    expect(full).toContain('\n    ~ cart.updatedAt "…14:02:11.384Z" → "…14:02:14.420Z"\n');
    expect(full).toContain('136 more changes were left out; get_state shows the whole state as it is now.');
    expect((await call('get_state_actions', { seq: seq - 1 })).text).toContain('12 actions before this one were folded into it');
    expect((await call('get_state_actions', { seq: 9999 })).text).toBe('There is no state change #9999 in this session.');
    expect((await call('get_state_actions', { store: 'nope' })).text).toContain('There is no store "nope"');
  });

  it("lists TanStack Query and SWR entries and reads one entry's data, credentials hidden", async () => {
    const { call } = await ready();
    const all = (await call('get_queries')).text;
    expect(all).toContain('Shop (session web-1) · queries (TanStack Query, tanstack-query:1): 6 of 7 entries match (the app sent 6).\n');
    expect(all).toContain('\n- ["todos"]: query, success, stale · 2 observers · data Array(2)\n');
    expect(all).toContain('\n- ["user",7]: query, error · 1 observer · error: AxiosError: Request failed with status code 404\n');
    // Mutations come after the queries, as in the UI.
    expect(all).toContain('\n- ["auth","token"]: query, success · 1 observer\n- 1 (addTodo): mutation, success\n');
    expect((await call('get_queries', { status: 'error' })).text).toMatch(/1 of 7 entries match \(the app sent 6\)\.\n- \["user",7\]/);
    expect((await call('get_queries', { status: 'fetching' })).text).toContain('\n- ["feed"]: infinite query, pending, fetching · 1 observer\n');
    expect((await call('get_queries', { status: 'stale' })).text).toContain('1 of 7 entries match');
    const page = (await call('get_queries', { search: 'todo', limit: 1 })).text;
    expect(page).toContain('2 of 7 entries match');
    expect(page).toContain('\n1 more; narrow it with status or search.\n');

    expect((await call('get_queries', { key: '["me"]' })).text).toContain('Data:\n{\n  "id": 1,\n  "name": "Ada",\n  "accessToken": "[hidden]"\n}');
    // Keyed like a credential, the whole entry is hidden, as storage hides such keys.
    expect((await call('get_queries', { key: '["auth","token"]' })).text).toMatch(/\nData:\n\[hidden\]$/);
    expect((await call('get_queries', { key: 'addTodo' })).text).toContain('1 (addTodo): mutation, success\nData:\n{\n  "id": 3,');
    expect((await call('get_queries', { key: '["todos"]', path: '[1].title' })).text).toMatch(/\nData at \[1\]\.title:\nWalk the capybara$/);
    expect((await call('get_queries', { key: '["todos"]', path: '[5]' })).text).toBe(
      'queries (TanStack Query, tanstack-query:1) has nothing at [5] in this entry. Leave out path to read all of its data.',
    );
    expect((await call('get_queries', { key: 'nope' })).text).toBe(
      'There is no entry nope in queries (TanStack Query, tanstack-query:1). get_queries without key lists them.',
    );
    expect((await call('get_queries', { store: 'shop' })).text).toBe(
      'shop (Redux, redux:1) is a Redux store; get_state reads its state and get_state_actions its changes.',
    );
  });

  it('reads a disconnected app from its history, and says what needs the app', async () => {
    const gone = await otherApp({ id: 'web-2', appName: 'Admin', platform: 'web', sdk: { name: 'test', version: '0' }, startedAt: 2, plugins: ['state'] }, [
      { seq: 1, ts: 1_700_000_000_000, kind: 'state.store', payload: { store: { id: 'redux:1', library: 'redux', label: 'admin', via: 'shim', actions: true } } },
      {
        seq: 2,
        ts: 1_700_000_000_001,
        kind: 'state.change',
        payload: { store: 'redux:1', rev: 1, cause: 'action', action: { type: 'users/loaded' }, ops: [{ op: 'set', path: ['users'], prev: [], value: [1, 2] }] },
      },
    ]);
    gone.close();
    const { call } = await connect();
    await until(() => call('list_sessions'), ({ text }) => text.includes('- web-2: Admin (web) · disconnected · 2 events'));

    const list = (await call('get_state', { session: 'web-2' })).text;
    expect(list).toMatch(
      /^Admin \(session web-2, disconnected\) is not connected, so the current state of its stores cannot be read\. The stores it registered:\n- redux:1: admin \(Redux\) · 1 action recorded, the last #2 users\/loaded at \S+ \(rev 1\)\n/,
    );
    expect(list).toContain('get_state_actions reads the changes recorded before it disconnected.');
    const state = await call('get_state', { session: 'web-2', store: 'admin' });
    expect(state.isError).toBe(true);
    expect(state.text).toContain('is not connected, so the current state of admin (Redux, redux:1) cannot be read.');
    const queries = await call('get_queries', { session: 'web-2' });
    expect(queries).toEqual({
      isError: true,
      text: 'Admin (session web-2, disconnected) is not connected, so its queries cannot be read. get_state lists the stores it registered.',
    });
    expect((await call('get_state_actions', { session: 'web-2' })).text).toMatch(/1 of 1 changes match\.\n#2 \S+ users\/loaded\n {4}~ users \[\] → \[1, 2\]\n/);
  });

  it('says why an app has no state to read', async () => {
    // Started before web-1, so the other tests keep reading web-1 by default.
    const legacy = await otherApp({ id: 'web-3', appName: 'Legacy', platform: 'web', sdk: { name: '@capybara-devtools/web', version: '0.2.1' }, startedAt: 0 });
    try {
      const { call } = await connect();
      // Without the state plugin the app is never asked; it would not answer.
      const result = await until(() => call('get_state', { session: 'web-3' }), ({ isError }) => !isError);
      expect(result.text).toBe(
        'Legacy (session web-3) uses @capybara-devtools/web 0.2.1, which does not report Redux, Zustand, TanStack Query, SWR or React Context state. Update it to the latest version.',
      );
      expect((await call('get_state_actions', { session: 'web-3' })).text).toContain('Legacy (session web-3): no state changes recorded. Legacy (session web-3) uses');
    } finally {
      legacy.terminate();
    }
  });

  it('shows credentials only when asked to', async () => {
    const { call } = await connect({ showSecrets: true });
    const users = (await call('get_request', { id: 'r1' })).text;
    expect(users).toContain('Authorization: Bearer abc');
    expect(users).toContain('http://api.test/users?token=secret123&page=2');
    expect((await call('get_state', { store: 'shop', path: 'user' })).text).toContain('"token": "abc123"');
    const actions = (await call('get_state_actions', { store: 'shop' })).text;
    expect(actions).toContain('"password":"hunter2"');
    expect(actions).toContain('auth/setToken {"payload":"eyJhbGciOiJIUzI1NiJ9.e30.c2ln"}');
    expect(actions).toContain('~ user.session.jwt "old-jwt" → "eyJhbGciOiJIUzI1NiJ9.e30.c2ln"');
    expect((await call('get_queries', { key: '["auth","token"]' })).text).toMatch(/\nData:\ntok-123$/);
  });

  it('says how to start Capybara when it is not running', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const free = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const { call } = await connect({ port: free });
    const result = await call('get_logs');
    expect(result.isError).toBe(true);
    expect(result.text).toContain(`Capybara is not running on 127.0.0.1:${free}`);
  });

  it('says that Capybara on another computer has to let it in, rather than that it is not running', async () => {
    // As Capybara answers a viewer from another computer when it runs without --remote-ui.
    const refusing = http.createServer();
    refusing.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
    await new Promise<void>((resolve) => refusing.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => refusing.close(resolve)));
    const { call } = await connect({ port: (refusing.address() as AddressInfo).port });
    const result = await call('get_logs');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('refused the connection');
    expect(result.text).toContain('--remote-ui');
  });

  it('says how to add Capybara to an app, without Capybara running', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const free = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const dir = mkdtempSync(join(tmpdir(), 'capybara-mcp-'));
    closers.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'shop', dependencies: { vite: '*' } }));
    const { client, call } = await connect({ port: free });

    const result = await call('get_setup_guide', { projectDir: dir });
    expect(result.isError).toBe(false);
    expect(result.text).toContain('# Add Capybara to shop');
    expect(result.text).toContain('Call list_sessions');

    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name)).toEqual(['setup']);
    const prompt = await client.getPrompt({ name: 'setup', arguments: { folder: 'apps/web' } });
    expect(prompt.messages[0]!.content).toEqual({
      type: 'text',
      text: 'Set up Capybara in the app in apps/web: call get_setup_guide with projectDir apps/web, make the changes it lists, then check with list_sessions that the app connects.',
    });
  });
});
