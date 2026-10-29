import { once } from 'node:events';
import http from 'node:http';
import net, { type AddressInfo, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { createServer, type CapybaraServer } from '../src/server.js';
import { isCapybaraServer } from '../src/start.js';
import { runStop, stopServer } from '../src/stop.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** A server as the CLI runs it, which stops when asked, or as the desktop app runs it, which doesn't. */
async function capybara(stoppable: boolean) {
  const server: CapybaraServer = createServer({
    port: 0,
    host: '127.0.0.1',
    version: '9.9.9',
    ...(stoppable && { onStop: () => void server.close() }),
  });
  const { port } = await server.start();
  cleanup.push(() => server.close());
  return port;
}

async function listening(server: net.Server) {
  await once(server, 'listening');
  cleanup.push(() => new Promise((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

describe('stopServer', () => {
  it('stops a server the CLI runs, and resolves once the port is free', async () => {
    const port = await capybara(true);
    expect(await stopServer(port, '127.0.0.1')).toBe(`Stopped Capybara 9.9.9 on 127.0.0.1:${port}.`);
    expect(await isCapybaraServer(port)).toBe(false);
  });

  it('says so when nothing runs on the port', async () => {
    const port = await listening(net.createServer().listen(0, '127.0.0.1'));
    await cleanup.pop()!();
    expect(await stopServer(port)).toBe(`Capybara is not running on localhost:${port}.`);
  });

  it('leaves the desktop app running and says to quit it', async () => {
    const port = await capybara(false);
    await expect(stopServer(port, '127.0.0.1')).rejects.toThrow('This Capybara is the desktop app: quit it from its menu.');
    expect(await isCapybaraServer(port)).toBe(true);
  });

  it('says how else to stop a server too old to be asked', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', (ws) => ws.send(JSON.stringify({ t: 'init', server: { version: '0.5.1', port: 0, addresses: [] }, sessions: [] })));
    await once(wss, 'listening');
    cleanup.push(() => new Promise((resolve) => wss.close(() => resolve())));
    const { port } = wss.address() as AddressInfo;
    const error = await stopServer(port, '127.0.0.1').catch((reason: Error) => reason);
    expect(String(error)).toContain(`Capybara 0.5.1 on 127.0.0.1:${port} is too old for capybara stop. Press Ctrl+C`);
    if (process.platform !== 'win32') expect(String(error)).toContain(`kill $(lsof -tiTCP:${port} -sTCP:LISTEN)`);
  });

  it('tells a port held by another program, or by one that never answers, from Capybara', async () => {
    const other = await listening(http.createServer((_req, res) => res.end('not capybara')).listen(0, '127.0.0.1'));
    await expect(stopServer(other, '127.0.0.1')).rejects.toThrow(`127.0.0.1:${other} is in use by a program other than Capybara.`);

    const sockets: Socket[] = [];
    const silent = await listening(net.createServer((socket) => sockets.push(socket)).listen(0, '127.0.0.1'));
    cleanup.push(async () => {
      for (const socket of sockets) socket.destroy();
    });
    await expect(stopServer(silent, '127.0.0.1', 200)).rejects.toThrow('is in use by a program other than Capybara.');
  });
});

describe('runStop', () => {
  it('turns down a port that is not one', async () => {
    await expect(runStop(['--port', 'seven'])).rejects.toThrow('Invalid port: seven');
  });
});
