import http from 'node:http';
import net, { type AddressInfo, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { isCapybaraServer, listen, PortInUseError, startOrReuse } from '../src/start.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function capybara(port = 0) {
  const started = await listen({ port, host: '127.0.0.1', version: 'test' });
  if (!started) throw new Error(`port ${port} is taken`);
  cleanup.push(() => started.server.close());
  return started.port;
}

async function otherServer() {
  const server = http.createServer((_req, res) => res.end('not capybara'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

describe('startOrReuse', () => {
  it('starts its own server on a free port', async () => {
    const started = await startOrReuse({ port: 0, host: '127.0.0.1' });
    expect(started.server).not.toBeNull();
    cleanup.push(() => started.server!.close());
    expect(await isCapybaraServer(started.port)).toBe(true);
  });

  it('reuses a Capybara server that already has the port, and says what it is', async () => {
    const port = await capybara();
    expect(await startOrReuse({ port, host: '127.0.0.1' })).toMatchObject({ port, server: null, running: { version: 'test', port } });
  });

  it('reports a port held by another program', async () => {
    const port = await otherServer();
    await expect(startOrReuse({ port, host: '127.0.0.1' })).rejects.toBeInstanceOf(PortInUseError);
  });

  it('notices a program that holds the port on loopback only', async () => {
    // Binding all interfaces would succeed on macOS, but localhost would still reach that program.
    const port = await otherServer();
    await expect(startOrReuse({ port })).rejects.toBeInstanceOf(PortInUseError);
  });
});

describe('listen', () => {
  it('returns null while the port is taken and succeeds once it is free', async () => {
    const port = await capybara();
    expect(await listen({ port, host: '127.0.0.1' })).toBeNull();
    await cleanup.pop()!();
    await capybara(port);
  });
});

describe('isCapybaraServer', () => {
  it('is false for a closed port and for a socket that never answers', async () => {
    const port = await otherServer();
    await cleanup.pop()!();
    expect(await isCapybaraServer(port)).toBe(false);

    const sockets: Socket[] = [];
    const silent = net.createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    cleanup.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => silent.close(resolve));
    });
    expect(await isCapybaraServer((silent.address() as AddressInfo).port, 200)).toBe(false);
  });
});
