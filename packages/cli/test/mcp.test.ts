import http from 'node:http';
import type { AddressInfo } from 'node:net';
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
    const { method, params } = message;
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
    session: { id: 'web-1', appName: 'Shop', platform: 'web', sdk: { name: 'test', version: '0' }, startedAt: 1, url: 'http://localhost:6868/' },
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

describe('capybara mcp', () => {
  it('describes its tools and the session it reads', async () => {
    const { client, call } = await ready();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'diagnose_request', 'get_logs', 'get_network', 'get_request', 'get_storage', 'get_websocket', 'list_sessions',
    ]);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true);
    const sessions = await call('list_sessions');
    expect(sessions.text).toContain('Capybara test on port');
    expect(sessions.text).toContain('- web-1: Shop (web, localhost:6868) · connected');
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

  it('shows credentials only when asked to', async () => {
    const { call } = await connect({ showSecrets: true });
    const users = (await call('get_request', { id: 'r1' })).text;
    expect(users).toContain('Authorization: Bearer abc');
    expect(users).toContain('http://api.test/users?token=secret123&page=2');
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
});
