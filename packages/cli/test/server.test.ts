import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { isLocalConnection } from '../src/security.js';
import { createServer, lanAddresses, reachableAddresses, type CapybaraServer, type ServerOptions } from '../src/server.js';

let server: CapybaraServer | undefined;
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

function connect(path: string, headers: Record<string, string> = {}, { host = '127.0.0.1', ...options }: WebSocket.ClientOptions & { host?: string } = {}) {
  const ws = new WebSocket(`ws://${host}:${port}${path}`, { headers, ...options });
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

const lan = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;

/** Status and body of a plain HTTP request for the UI, `options` as for `http.get`. */
function get(options: http.RequestOptions = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/', ...options }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

const statusOf = async (options?: http.RequestOptions) => (await get(options)).status;
const bodyOf = async (options?: http.RequestOptions) => (await get(options)).body;

const session = (id = 'app-1') => ({
  id,
  appName: 'Shop',
  platform: 'ios',
  sdk: { name: 'test', version: '0' },
  startedAt: 1,
});

const log = (seq: number) => ({ seq, ts: seq, kind: 'log', payload: { level: 'log', source: 'console', args: [`#${seq}`] } });

const stateStore = (seq: number, id = 'redux:1', info: Record<string, unknown> = {}) => ({
  seq,
  ts: seq,
  kind: 'state.store',
  payload: { store: { id, library: 'redux', label: 'Store', via: 'shim', actions: true, ...info } },
});

const stateChange = (seq: number) => ({
  seq,
  ts: seq,
  kind: 'state.change',
  payload: { store: 'redux:1', rev: seq, cause: 'action', action: { type: 'tick' }, ops: [] },
});

const stateEntries = (seq: number) => ({ seq, ts: seq, kind: 'state.entries', payload: { store: 'swr:1', upserts: [], removed: [] } });

async function connectApp(id = 'app-1') {
  const app = connect('/client');
  await app.opened;
  app.send({ t: 'hello', protocol: 1, session: session(id) });
  const welcome = await app.next((m) => m.t === 'welcome');
  return { app, welcome };
}

/** The server stores events before passing them on, so once the viewer has them, history has them too. */
async function deliver(app: ReturnType<typeof connect>, ui: ReturnType<typeof connect>, events: { seq: number }[]) {
  app.send({ t: 'events', events });
  const last = events.at(-1)!.seq;
  await ui.next((m) => m.t === 'events' && m.events.at(-1).seq === last);
}

async function load(sessionId = 'app-1') {
  const late = viewer();
  await late.opened;
  const { sessions } = await late.next((m) => m.t === 'init');
  late.send({ t: 'history', sessionId });
  const { events } = await late.next((m) => m.t === 'history');
  return { meta: sessions.find((s: any) => s.info.id === sessionId), events };
}

describe('event relay', () => {
  it('gives a session the time it connected when the app sends no start time', async () => {
    await start();
    const app = connect('/client');
    await app.opened;
    const { startedAt: _, ...withoutStart } = session();
    app.send({ t: 'hello', protocol: 1, session: withoutStart });
    await app.next((m) => m.t === 'welcome');
    const { meta } = await load();
    expect(meta.info.startedAt).toBeGreaterThan(Date.now() - 5_000);
  });

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

  it('sends a long history in parts to viewers that ask, and in one message to the others', async () => {
    await start();
    const ui = viewer();
    await ui.opened;
    const { app } = await connectApp();
    const body = 'x'.repeat(128 * 1024);
    const responses = Array.from({ length: 40 }, (_, i) => ({
      seq: i + 1,
      ts: i + 1,
      kind: 'network.response',
      payload: { id: `r${i + 1}`, status: 200, headers: {}, body: { kind: 'text', text: body }, duration: 1 },
    }));
    await deliver(app, ui, responses);
    const histories = () => ui.messages.filter((m) => m.t === 'history');

    ui.send({ t: 'history', sessionId: 'app-1', parts: true });
    await ui.next((m) => m.t === 'history' && !m.more);
    const parts = histories();
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((part) => part.more)).toEqual([...parts.slice(1).map(() => true), undefined]);
    expect(parts.flatMap((part) => part.events).map((e: any) => e.seq)).toEqual(responses.map((e) => e.seq));

    // Viewers before 0.5.1 do not ask, and would keep only the first part.
    ui.send({ t: 'history', sessionId: 'app-1' });
    const whole = await ui.next((m) => m.t === 'history' && m.events.length === responses.length);
    expect(whole.more).toBeUndefined();
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

describe('taking over', () => {
  it('keeps what another server recorded, and lets its apps carry on in their sessions', async () => {
    await start();
    const ui = viewer();
    await ui.opened;
    const { app } = await connectApp();
    await deliver(app, ui, [log(1), stateStore(2), stateChange(3), log(4)]);
    const before = await load();
    const recorded = server!.recorded();
    await server!.close();

    await start({ sessions: recorded });
    const after = await load();
    expect(after.meta).toMatchObject({ info: { id: 'app-1' }, connected: false, eventCount: 4 });
    expect(after.events).toEqual(before.events);

    const next = viewer();
    await next.opened;
    const again = await connectApp();
    expect(again.welcome).toEqual({ t: 'welcome', lastSeq: 4 });
    // The SDK sends again what it holds after that seq; anything older would be a duplicate.
    again.app.send({ t: 'events', events: [log(4), log(5)] });
    expect((await next.next((m) => m.t === 'events')).events.map((e: any) => e.seq)).toEqual([5]);
  });
});

describe('state events', () => {
  it('keeps them apart, so busy stores never push logs out', async () => {
    await start();
    const ui = viewer();
    await ui.opened;
    const { app } = await connectApp();
    // 5000 logs and 3000 changes, interleaved, after the store registered.
    const sent = [stateStore(1), ...Array.from({ length: 8_000 }, (_, i) => (i % 8 < 5 ? log(i + 2) : stateChange(i + 2)))];
    await deliver(app, ui, sent);

    const { meta, events } = await load();
    const changes = sent.filter((e) => e.kind === 'state.change');
    const kept = [...sent.filter((e) => e.kind !== 'state.change'), ...changes.slice(-2_000)].map((e) => e.seq);
    expect(events.filter((e: any) => e.kind === 'log')).toHaveLength(5_000);
    expect(events[0]).toEqual(stateStore(1));
    expect(events.map((e: any) => e.seq)).toEqual(kept.sort((a, b) => a - b));
    expect(meta.eventCount).toBe(7_001);
  });

  it('keeps only the latest registration of each store', async () => {
    await start();
    const ui = viewer();
    await ui.opened;
    const { app } = await connectApp();
    await deliver(app, ui, [stateStore(1, 'redux:1'), stateStore(2, 'redux:2'), stateStore(3, 'redux:1', { disposed: true })]);
    expect((await load()).events).toEqual([stateStore(2, 'redux:2'), stateStore(3, 'redux:1', { disposed: true })]);
  });

  it('keeps 200 stores, forgetting the longest disposed first', async () => {
    await start();
    const ui = viewer();
    await ui.opened;
    const { app } = await connectApp();
    const ids = async () => (await load()).events.map((e: any) => e.payload.store.id);
    const live = Array.from({ length: 200 }, (_, i) => stateStore(i + 1, `redux:${i}`));
    // Disposed in the opposite order to how they registered.
    const disposed = [stateStore(201, 'redux:5', { disposed: true }), stateStore(202, 'redux:0', { disposed: true })];

    await deliver(app, ui, [...live, ...disposed, stateStore(203, 'redux:200')]);
    let kept = await ids();
    expect(kept).toHaveLength(200);
    expect(kept).toContain('redux:0');
    expect(kept).not.toContain('redux:5');

    // Then the other disposed store, then the live one updated longest ago.
    await deliver(app, ui, [stateStore(204, 'redux:201'), stateStore(205, 'redux:202')]);
    kept = await ids();
    expect(kept).toHaveLength(200);
    expect(kept).not.toContain('redux:0');
    expect(kept[0]).toBe('redux:2');
  });

  it('keeps as many as maxStateEvents says, apart from other events', async () => {
    await start({ maxStateEvents: 2 });
    const ui = viewer();
    await ui.opened;
    const { app } = await connectApp();
    await deliver(app, ui, [stateChange(1), stateEntries(2), log(3), stateChange(4)]);
    expect((await load()).events.map((e: any) => e.seq)).toEqual([2, 3, 4]);
  });

  it('clears the timeline but keeps the registered stores', async () => {
    await start();
    const ui = viewer();
    await ui.opened;
    const { app } = await connectApp();
    await deliver(app, ui, [stateStore(1), stateChange(2), stateEntries(3), log(4)]);

    ui.send({ t: 'clear', sessionId: 'app-1' });
    await ui.next((m) => m.t === 'cleared');
    expect((await load()).events).toEqual([stateStore(1)]);

    await deliver(app, ui, [stateChange(5), stateStore(6, 'redux:1', { disposed: true })]);
    expect((await load()).events).toEqual([stateChange(5), stateStore(6, 'redux:1', { disposed: true })]);
  });

  it('clears only the state timeline when the State tab asks', async () => {
    await start();
    const ui = viewer();
    await ui.opened;
    const { app } = await connectApp();
    await deliver(app, ui, [stateStore(1), stateChange(2), log(3), stateEntries(4)]);

    ui.send({ t: 'clear', sessionId: 'app-1', scope: 'state' });
    expect(await ui.next((m) => m.t === 'cleared')).toEqual({ t: 'cleared', sessionId: 'app-1', scope: 'state' });
    expect((await load()).events).toEqual([stateStore(1), log(3)]);
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

  it('still finds a request after thousands of state events', async () => {
    const api = http.createServer((_req, res) => res.writeHead(401).end());
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(api.address() as AddressInfo).port}/me`;
    try {
      await start();
      const ui = viewer();
      await ui.opened;
      const page = connect('/client');
      await page.opened;
      page.send({ t: 'hello', protocol: 1, session: { ...session('web-1'), platform: 'web', url: 'http://localhost:6868/home' } });
      await page.next((m) => m.t === 'welcome');
      const request = { seq: 1, ts: 1, kind: 'network.request', payload: { id: 'r1', initiator: 'fetch', method: 'GET', url, headers: {} } };
      await deliver(page, ui, [request, ...Array.from({ length: 5_000 }, (_, i) => stateChange(i + 2))]);

      ui.send({ t: 'diagnose', id: 'd1', sessionId: 'web-1', requestId: 'r1' });
      expect(await ui.next((m) => m.id === 'd1')).toMatchObject({ ok: true, result: { verdict: 'cors' } });
    } finally {
      await new Promise((resolve) => api.close(resolve));
    }
  });
});

describe('hints', () => {
  const unreadable = "Expo Go on Android (Pixel 9) can't be read through Metro: its JavaScript engine does not support debugging.";

  it('shows each hint in the UI once, and passes it on', async () => {
    const printed: string[] = [];
    await start({ onHint: (hint) => printed.push(hint) });
    const before = viewer();
    await before.opened;
    server!.hint(unreadable);
    server!.hint(unreadable);
    expect((await before.next((m) => m.t === 'server')).server.hints).toEqual([unreadable]);
    expect(printed).toEqual([unreadable]);

    // A UI opened later gets them with the rest of the server info.
    const after = viewer();
    expect((await after.next((m) => m.t === 'init')).server.hints).toEqual([unreadable]);
  });

  it('keeps the newest ten', async () => {
    await start();
    for (let i = 1; i <= 12; i++) server!.hint(`Hint ${i}`);
    const ui = viewer();
    expect((await ui.next((m) => m.t === 'init')).server.hints).toEqual(Array.from({ length: 10 }, (_, i) => `Hint ${i + 3}`));
  });
});

describe('stopping', () => {
  it('answers a viewer on this computer, after what it is still being sent, before it stops', async () => {
    let stopping: Promise<void> | undefined;
    await start({
      onStop: () => {
        stopping = server!.close();
      },
    });
    const ui = viewer();
    expect((await ui.next((m) => m.t === 'init')).server.stop).toBe(true);
    const { app } = await connectApp();
    const body = 'x'.repeat(128 * 1024);
    const responses = Array.from({ length: 128 }, (_, i) => ({
      seq: i + 1,
      ts: i + 1,
      kind: 'network.response',
      payload: { id: `r${i + 1}`, status: 200, headers: {}, body: { kind: 'text', text: body }, duration: 1 },
    }));
    await deliver(app, ui, responses);
    const closed = new Promise<void>((resolve) => ui.ws.once('close', () => resolve()));
    // 16 MB is more than the socket buffers of both ends hold, so it is still being sent when the stop comes.
    ui.send({ t: 'history', sessionId: 'app-1' });
    ui.send({ t: 'stop', id: 's1' });
    await closed;
    expect(ui.messages.at(-2).events).toHaveLength(responses.length);
    expect(ui.messages.at(-1)).toEqual({ t: 'result', id: 's1', ok: true });
    await stopping;
  });

  it('tells viewers of a server without onStop, as in the desktop app, to quit the app', async () => {
    await start();
    const ui = viewer();
    expect((await ui.next((m) => m.t === 'init')).server.stop).toBe(false);
    ui.send({ t: 'stop', id: 's1' });
    expect(await ui.next((m) => m.t === 'result')).toEqual({
      t: 'result',
      id: 's1',
      ok: false,
      error: 'This Capybara is the desktop app: quit it from its menu',
    });
  });

  it.skipIf(!lan)('stops only for this computer, even with remote UI', async () => {
    const stops: number[] = [];
    await start({ remoteUi: true, onStop: () => stops.push(1) });
    const device = connect('/viewer', { origin: `http://127.0.0.1:${port}` }, { localAddress: lan });
    expect((await device.next((m) => m.t === 'init')).server.stop).toBe(false);
    device.send({ t: 'stop', id: 'd1' });
    expect(await device.next((m) => m.t === 'result')).toEqual({
      t: 'result',
      id: 'd1',
      ok: false,
      error: 'Only the computer Capybara runs on can stop it',
    });
    expect(stops).toEqual([]);
  });
});

describe('in the background', () => {
  it('tells viewers on this computer where it writes its output', async () => {
    await start({ log: '/tmp/capybara-x/capybara.log' });
    const ui = viewer();
    expect((await ui.next((m) => m.t === 'init')).server.log).toBe('/tmp/capybara-x/capybara.log');
  });

  it.skipIf(!lan)('keeps it from other devices, even with remote UI', async () => {
    await start({ remoteUi: true, log: '/tmp/capybara-x/capybara.log' });
    const device = connect('/viewer', { origin: `http://127.0.0.1:${port}` }, { localAddress: lan });
    expect((await device.next((m) => m.t === 'init')).server.log).toBeUndefined();
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

  it('refuses plain HTTP requests addressed to other hosts, with a page that says what to open instead', async () => {
    await start();
    expect(await statusOf({ headers: { host: 'evil.test' } })).toBe(403);
    // Such as this computer's own name on the network.
    const page = await get({ headers: { host: `devbox.local:${port}` } });
    expect(page.status).toBe(403);
    expect(page.body).toContain('Open Capybara at localhost or an IP address');
    expect(page.body).toContain(`<a href="http://localhost:${port}">`);
  });

  // Another device, as the server sees it: a peer at this machine's LAN address, on loopback.
  it.skipIf(!lan)('shows the UI and what apps sent only to this machine, while apps connect from anywhere', async () => {
    const hints: string[] = [];
    await start({ onHint: (hint) => hints.push(hint) });
    const ui = viewer();
    await ui.opened;
    const elsewhere = { localAddress: lan };
    await expect(connect('/viewer', { origin: `http://127.0.0.1:${port}` }, elsewhere).opened).rejects.toThrow('HTTP 403');
    expect(await statusOf(elsewhere)).toBe(403);
    await expect(connect('/client', {}, elsewhere).opened).resolves.toBeUndefined();
    expect(await statusOf()).toBe(200);

    // The device is told how to get in, and the terminal and the UI once which device was turned away.
    expect(await bodyOf(elsewhere)).toContain('--remote-ui');
    expect(hints).toEqual([expect.stringContaining(`${lan} was turned away`)]);
    expect(hints[0]).toContain('--remote-ui');
    expect(hints[0]).toContain('Let Other Devices Open the UI');
    expect((await ui.next((m) => m.t === 'server')).server.hints).toEqual(hints);
  });

  it.skipIf(!lan)('says which apps connect from another device', async () => {
    await start();
    const phone = connect('/client', {}, { localAddress: lan });
    await phone.opened;
    phone.send({ t: 'hello', protocol: 1, session: session('phone') });
    await phone.next((m) => m.t === 'welcome');
    await connectApp('simulator');
    expect((await load('phone')).meta.address).toBe(lan);
    expect((await load('simulator')).meta).not.toHaveProperty('address');
  });

  it.skipIf(!lan)('lets other devices open the UI with remoteUi', async () => {
    await start({ remoteUi: true });
    const elsewhere = { localAddress: lan };
    await expect(connect('/viewer', { origin: `http://127.0.0.1:${port}` }, elsewhere).opened).resolves.toBeUndefined();
    expect(await statusOf(elsewhere)).toBe(200);
  });

  it.skipIf(!lan)('takes the address of a Flutter app only from this machine, even with remote UI', async () => {
    await start({ remoteUi: true });
    const attached: string[] = [];
    server!.setFlutterAttach(async (uri) => {
      attached.push(uri);
      return { appName: 'shop' };
    });
    const mine = viewer();
    await mine.opened;
    const device = connect('/viewer', { origin: `http://127.0.0.1:${port}` }, { localAddress: lan });
    await device.opened;
    expect((await mine.next((m) => m.t === 'init')).server.flutter).toEqual({ attach: true });
    expect((await device.next((m) => m.t === 'init')).server.flutter).toEqual({ attach: false });

    device.send({ t: 'attach', id: 'd1', uri: 'http://127.0.0.1:50300/abc=/' });
    expect(await device.next((m) => m.t === 'result')).toEqual({
      t: 'result',
      id: 'd1',
      ok: false,
      error: 'Only the computer Capybara runs on can add Flutter apps',
    });
    mine.send({ t: 'attach', id: 'm1', uri: 'http://127.0.0.1:50300/abc=/' });
    expect(await mine.next((m) => m.t === 'result')).toEqual({ t: 'result', id: 'm1', ok: true, result: { appName: 'shop' } });
    expect(attached).toEqual(['http://127.0.0.1:50300/abc=/']);
  });

  it.skipIf(!lan)('lets other devices in and out as remote UI is turned on and off while running', async () => {
    await start();
    const elsewhere = { localAddress: lan };
    const ui = viewer();
    await ui.opened;
    expect(await statusOf(elsewhere)).toBe(403);
    server!.setRemoteUi(true);
    // The device turned away before made the server send a hint already.
    await ui.next((m) => m.t === 'server' && m.server.remoteUi);
    expect(await statusOf(elsewhere)).toBe(200);
    const device = connect('/viewer', { origin: `http://127.0.0.1:${port}` }, elsewhere);
    await device.opened;
    const closed = new Promise<number>((resolve) => device.ws.once('close', (code) => resolve(code)));
    server!.setRemoteUi(false);
    // The device is let go; this machine's viewer stays and hears of the change.
    expect(await closed).toBe(1008);
    await vi.waitFor(() => expect(ui.messages.filter((m) => m.t === 'server').at(-1).server.remoteUi).toBe(false));
    expect(await statusOf(elsewhere)).toBe(403);
  });

  it.skipIf(!lan)('opens the UI at its LAN address on this machine', async () => {
    await start({ host: lan });
    await expect(connect('/viewer', { origin: `http://${lan}:${port}` }, { host: lan }).opened).resolves.toBeUndefined();
  });

  it('tells local connections from others, IPv4 peers of a dual-stack server included', () => {
    expect(isLocalConnection({ remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' })).toBe(true);
    expect(isLocalConnection({ remoteAddress: '::ffff:127.0.0.1', localAddress: '::ffff:127.0.0.1' })).toBe(true);
    expect(isLocalConnection({ remoteAddress: '::1', localAddress: '::1' })).toBe(true);
    expect(isLocalConnection({ remoteAddress: '::ffff:192.168.1.5', localAddress: '::ffff:192.168.1.5' })).toBe(true);
    expect(isLocalConnection({ remoteAddress: '::ffff:192.168.1.7', localAddress: '::ffff:192.168.1.5' })).toBe(false);
    expect(isLocalConnection({ remoteAddress: undefined, localAddress: undefined })).toBe(false);
  });
});

describe('addresses for phones', () => {
  it('lists none when the server listens on loopback only', async () => {
    await start();
    const ui = viewer();
    await ui.opened;
    expect((await ui.next((m) => m.t === 'init')).server).toMatchObject({ addresses: [], remoteUi: false });
    expect(reachableAddresses('::1')).toEqual([]);
  });

  it('tells the UI whether other devices may open it, so it offers a QR code or the flag', async () => {
    await start({ remoteUi: true });
    const ui = viewer();
    await ui.opened;
    expect((await ui.next((m) => m.t === 'init')).server.remoteUi).toBe(true);
  });

  it('lists the LAN addresses on all interfaces, or the one address it listens on', () => {
    expect(reachableAddresses('::')).toEqual(lanAddresses());
    expect(reachableAddresses('0.0.0.0')).toEqual(lanAddresses());
    expect(reachableAddresses('192.168.1.5')).toEqual(['192.168.1.5']);
  });
});

describe('static UI', () => {
  it('serves files, falls back to index.html for routes, and blocks traversal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'capybara-ui-'));
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
