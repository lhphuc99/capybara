import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createServer, type DevsightServer, type ServerOptions } from '../src/server.js';

let server: DevsightServer | undefined;
let port = 0;
const sockets: WebSocket[] = [];

async function start(options: Partial<ServerOptions> = {}) {
  server = createServer({ port: 0, host: '127.0.0.1', version: 'test', commandTimeout: 300, ...options });
  ({ port } = await server.start());
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.close();
  server = undefined;
});

function connect(path: string, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
  sockets.push(ws);
  const messages: any[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
  const next = async (predicate: (message: any) => boolean): Promise<any> => {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const found = messages.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`Timed out; got ${JSON.stringify(messages)}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  const send = (message: unknown) => ws.send(JSON.stringify(message));
  return { ws, messages, opened, next, send };
}

const viewer = () => connect('/viewer', { origin: `http://127.0.0.1:${port}` });

const session = (id = 'app-1') => ({
  id,
  appName: 'Shop',
  platform: 'ios',
  sdk: { name: 'test', version: '0' },
  startedAt: 1,
});

const log = (seq: number) => ({ seq, ts: seq, kind: 'log', payload: { level: 'log', source: 'console', args: [`#${seq}`] } });

async function connectApp(id = 'app-1') {
  const app = connect('/client');
  await app.opened;
  app.send({ t: 'hello', protocol: 1, session: session(id) });
  const welcome = await app.next((m) => m.t === 'welcome');
  return { app, welcome };
}

describe('event relay', () => {
  it('streams app events to viewers and serves history to late viewers', async () => {
    await start();
    const ui = viewer();
    await ui.opened;
    expect(await ui.next((m) => m.t === 'init')).toMatchObject({ server: { version: 'test', port }, sessions: [] });

    const { app, welcome } = await connectApp();
    expect(welcome).toEqual({ t: 'welcome', lastSeq: 0 });
    expect(await ui.next((m) => m.t === 'session')).toMatchObject({ session: { info: { id: 'app-1' }, connected: true } });

    app.send({ t: 'events', events: [log(1), log(2)] });
    expect((await ui.next((m) => m.t === 'events')).events.map((e: any) => e.seq)).toEqual([1, 2]);

    const late = viewer();
    await late.opened;
    expect(await late.next((m) => m.t === 'init')).toMatchObject({ sessions: [{ eventCount: 2, connected: true }] });
    late.send({ t: 'history', sessionId: 'app-1' });
    expect((await late.next((m) => m.t === 'history')).events).toHaveLength(2);
  });

  it('tells a reconnecting app where to resume and drops replayed events', async () => {
    await start();
    const ui = viewer();
    await ui.opened;
    const first = await connectApp();
    first.app.send({ t: 'events', events: [log(1), log(2), log(3)] });
    await ui.next((m) => m.t === 'events');
    first.app.ws.close();
    await ui.next((m) => m.t === 'session' && m.session.connected === false);

    const second = await connectApp();
    expect(second.welcome).toEqual({ t: 'welcome', lastSeq: 3 });
    second.app.send({ t: 'events', events: [log(2), log(3), log(4)] });
    const batches = await (async () => {
      await ui.next((m) => m.t === 'events' && m.events.some((e: any) => e.seq === 4));
      return ui.messages.filter((m) => m.t === 'events');
    })();
    expect(batches.at(-1).events.map((e: any) => e.seq)).toEqual([4]);
  });

  it('rejects apps that speak another protocol version', async () => {
    await start();
    const app = connect('/client');
    await app.opened;
    app.send({ t: 'hello', protocol: 99, session: session() });
    expect(await app.next((m) => m.t === 'reject')).toMatchObject({ reason: expect.stringContaining('99') });
  });

  it('clears events and removes disconnected sessions on request', async () => {
    await start();
    const ui = viewer();
    await ui.opened;
    const { app } = await connectApp();
    app.send({ t: 'events', events: [log(1)] });
    await ui.next((m) => m.t === 'events');

    ui.send({ t: 'clear', sessionId: 'app-1' });
    await ui.next((m) => m.t === 'cleared');
    ui.send({ t: 'history', sessionId: 'app-1' });
    expect((await ui.next((m) => m.t === 'history')).events).toEqual([]);

    app.ws.close();
    await ui.next((m) => m.t === 'session' && !m.session.connected);
    ui.send({ t: 'remove', sessionId: 'app-1' });
    expect(await ui.next((m) => m.t === 'session.removed')).toEqual({ t: 'session.removed', sessionId: 'app-1' });
  });
});

describe('commands', () => {
  it('routes a command to the app and the result back to the asking viewer', async () => {
    await start();
    const ui = viewer();
    await ui.opened;
    const { app } = await connectApp();

    ui.send({ t: 'command', id: 'v1', sessionId: 'app-1', plugin: 'storage', method: 'list' });
    const command = await app.next((m) => m.t === 'command');
    expect(command).toMatchObject({ plugin: 'storage', method: 'list' });
    expect(command.id).not.toBe('v1');

    app.send({ t: 'result', id: command.id, ok: true, result: [{ id: 'localStorage' }] });
    expect(await ui.next((m) => m.t === 'result')).toEqual({ t: 'result', id: 'v1', ok: true, result: [{ id: 'localStorage' }] });
  });

  it('fails fast for disconnected apps and times out silent ones', async () => {
    await start();
    const ui = viewer();
    await ui.opened;
    ui.send({ t: 'command', id: 'v1', sessionId: 'nobody', plugin: 'storage', method: 'list' });
    expect(await ui.next((m) => m.id === 'v1')).toMatchObject({ ok: false, error: 'The app is not connected' });

    await connectApp();
    ui.send({ t: 'command', id: 'v2', sessionId: 'app-1', plugin: 'storage', method: 'list' });
    expect(await ui.next((m) => m.id === 'v2')).toMatchObject({ ok: false, error: 'The app did not answer in time' });
  });
});

describe('diagnosing failed requests', () => {
  it('checks a web request from this machine, and refuses sessions without a page', async () => {
    const api = http.createServer((_req, res) => res.writeHead(401).end());
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(api.address() as AddressInfo).port}/me`;
    const failed = (seq: number) => [
      { seq, ts: seq, kind: 'network.request', payload: { id: 'r1', initiator: 'fetch', method: 'GET', url, headers: {} } },
      { seq: seq + 1, ts: seq, kind: 'network.error', payload: { id: 'r1', message: 'Failed to fetch', duration: 3, cause: 'cross-origin', credentials: true } },
    ];
    try {
      await start();
      const ui = viewer();
      await ui.opened;
      const page = connect('/client');
      await page.opened;
      page.send({ t: 'hello', protocol: 1, session: { ...session('web-1'), platform: 'web', url: 'http://localhost:6868/home' } });
      await page.next((m) => m.t === 'welcome');
      page.send({ t: 'events', events: failed(1) });
      await ui.next((m) => m.t === 'events' && m.sessionId === 'web-1');

      ui.send({ t: 'diagnose', id: 'd1', sessionId: 'web-1', requestId: 'r1' });
      const reply = await ui.next((m) => m.id === 'd1');
      expect(reply).toMatchObject({ ok: true, result: { verdict: 'cors', sent: [`GET ${url} (without cookies)`] } });
      expect(reply.result.summary).toContain('has no Access-Control-Allow-Origin header');
      ui.send({ t: 'diagnose', id: 'd2', sessionId: 'web-1', requestId: 'gone' });
      expect(await ui.next((m) => m.id === 'd2')).toMatchObject({ ok: false, error: 'This request is no longer in the session' });

      const { app } = await connectApp('rn-1');
      app.send({ t: 'events', events: failed(1) });
      await ui.next((m) => m.t === 'events' && m.sessionId === 'rn-1');
      ui.send({ t: 'diagnose', id: 'd3', sessionId: 'rn-1', requestId: 'r1' });
      expect((await ui.next((m) => m.id === 'd3')).error).toContain('CORS applies only in browsers');
    } finally {
      await new Promise((resolve) => api.close(resolve));
    }
  });
});

describe('access control', () => {
  it('refuses viewer sockets from other origins', async () => {
    await start();
    await expect(connect('/viewer', { origin: 'http://evil.test' }).opened).rejects.toThrow('HTTP 403');
    await expect(connect('/viewer').opened).rejects.toThrow('HTTP 403');
  });

  it('refuses DNS-rebound hosts even when origin and host agree', async () => {
    await start();
    const forged = connect('/viewer', { Host: `evil.test:${port}`, origin: `http://evil.test:${port}` });
    await expect(forged.opened).rejects.toThrow('HTTP 403');
  });

  it('accepts extra origins passed on the command line', async () => {
    await start({ allowedOrigins: ['http://localhost:5174'] });
    await expect(connect('/viewer', { origin: 'http://localhost:5174' }).opened).resolves.toBeUndefined();
  });

  it('refuses plain HTTP requests addressed to other hosts', async () => {
    await start();
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/', headers: { host: 'evil.test' } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on('error', reject);
    });
    expect(status).toBe(403);
  });
});

describe('static UI', () => {
  it('serves files, falls back to index.html for routes, and blocks traversal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devsight-ui-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>UI</title>');
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
    try {
      await start({ uiDir: dir });
      const base = `http://127.0.0.1:${port}`;
      const index = await fetch(`${base}/`);
      expect(index.headers.get('content-type')).toContain('text/html');
      expect(await index.text()).toContain('<title>UI</title>');

      const script = await fetch(`${base}/assets/app.js`);
      expect(script.headers.get('cache-control')).toContain('immutable');
      expect(await script.text()).toBe('console.log(1)');

      expect(await (await fetch(`${base}/sessions/abc`)).text()).toContain('<title>UI</title>');
      expect((await fetch(`${base}/missing.js`)).status).toBe(404);
      // Plain `..` segments are normalized away by URL parsing; encoded slashes survive until decoding.
      expect((await fetch(`${base}/..%2f..%2fetc%2fpasswd`)).status).toBe(403);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
