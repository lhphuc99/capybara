import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createServer, type CapybaraServer } from '../src/server.js';
import { fetchLatestVersions } from '../src/updates.js';

const registry = (versions: Record<string, string | number>) => {
  const requested: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const href = String(url);
    requested.push(href);
    const name = decodeURIComponent(href.replace('https://registry.example/', '').replace(/\/latest$/, ''));
    const version = versions[name];
    if (version === undefined) return new Response('{"error":"Not found"}', { status: 404 });
    if (version === 0) throw new TypeError('fetch failed');
    return Response.json({ name, version });
  }) as typeof fetch;
  return { fetchImpl, requested };
};

describe('fetchLatestVersions', () => {
  it('reads the latest dist-tag of the CLI and each SDK', async () => {
    const { fetchImpl, requested } = registry({
      'capybara-devtools': '0.3.0',
      '@capybara-devtools/web': '0.3.0',
      '@capybara-devtools/react-native': '0.2.1',
    });
    expect(await fetchLatestVersions('https://registry.example', fetchImpl)).toEqual({
      'capybara-devtools': '0.3.0',
      '@capybara-devtools/web': '0.3.0',
      '@capybara-devtools/react-native': '0.2.1',
    });
    expect(requested).toContain('https://registry.example/@capybara-devtools%2fweb/latest');
  });

  it('keeps what it could read when some lookups fail', async () => {
    const { fetchImpl } = registry({ 'capybara-devtools': '0.3.0', '@capybara-devtools/web': 0 });
    expect(await fetchLatestVersions('https://registry.example/', fetchImpl)).toEqual({ 'capybara-devtools': '0.3.0' });
  });

  it('gives undefined when nothing could be read, e.g. offline', async () => {
    const { fetchImpl } = registry({ 'capybara-devtools': 0 });
    expect(await fetchLatestVersions('https://registry.example/', fetchImpl)).toBeUndefined();
  });
});

describe('server', () => {
  let server: CapybaraServer | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await server?.close();
    server = undefined;
  });

  it('tells viewers the latest versions once it has them', async () => {
    let release!: () => void;
    const lookedUp = new Promise<void>((resolve) => (release = resolve));
    server = createServer({
      port: 0,
      host: '127.0.0.1',
      version: '0.1.0',
      latestVersions: async () => {
        await lookedUp;
        return { 'capybara-devtools': '0.2.0' };
      },
    });
    const { port } = await server.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/viewer`, { origin: `http://127.0.0.1:${port}` });
    sockets.push(ws);
    const messages: any[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await new Promise((resolve) => ws.once('open', resolve));
    await waitFor(() => messages.some((m) => m.t === 'init'));
    expect(messages[0].server.latest).toBeUndefined();

    release();
    await waitFor(() => messages.some((m) => m.t === 'server'));
    expect(messages.find((m) => m.t === 'server').server).toMatchObject({
      version: '0.1.0',
      latest: { 'capybara-devtools': '0.2.0' },
    });
  });

  it('looks nothing up without latestVersions', async () => {
    server = createServer({ port: 0, host: '127.0.0.1', version: '0.1.0' });
    const { port } = await server.start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/viewer`, { origin: `http://127.0.0.1:${port}` });
    sockets.push(ws);
    const init = await new Promise<any>((resolve) => ws.once('message', (data) => resolve(JSON.parse(data.toString()))));
    expect(init.server.latest).toBeUndefined();
  });
});

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
