import net from 'node:net';
import { VIEWER_PATH, type ServerInfo } from '@capybara-devtools/protocol';
import { WebSocket, type RawData } from 'ws';
import { createServer, type CapybaraServer, type ServerOptions } from './server.js';

export class PortInUseError extends Error {
  constructor(readonly port: number) {
    super(`Port ${port} is in use by a program other than Capybara`);
  }
}

/** `address` is where the server listens, as `CapybaraServer.start()` says. */
export type Started =
  | { port: number; address: string; server: CapybaraServer }
  /** Another Capybara process (the desktop app, another `capybara`) already serves the port; `running` is how it greets. */
  | { port: number; server: null; running: ServerInfo };

/** Starts a server, or reuses the Capybara server that already has the port. */
export async function startOrReuse(options: ServerOptions): Promise<Started> {
  const own = await listen(options);
  if (own) return own;
  const running = await readServerInfo(options.port);
  if (running) return { port: options.port, server: null, running };
  throw new PortInUseError(options.port);
}

/** Resolves to null when the port is taken. */
export async function listen(options: ServerOptions): Promise<{ port: number; address: string; server: CapybaraServer } | null> {
  if (!options.host && options.port !== 0 && (await isHeldElsewhere(options.port))) return null;
  const server = createServer(options);
  try {
    return { ...(await server.start()), server };
  } catch (error) {
    await server.close();
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return null;
    throw error;
  }
}

/**
 * macOS lets a server bind all interfaces while another program holds the same port on loopback
 * or on IPv4 only, and localhost connections then still reach that program. 0.0.0.0 goes first:
 * briefly binding loopback while another server has all interfaces would take its connections.
 */
async function isHeldElsewhere(port: number): Promise<boolean> {
  for (const host of ['0.0.0.0', '127.0.0.1', '::1']) {
    const code = await new Promise<string | undefined>((resolve) => {
      const probe = net.createServer();
      probe.once('error', (error: NodeJS.ErrnoException) => resolve(error.code));
      probe.listen(port, host, () => probe.close(() => resolve(undefined)));
    });
    if (code === 'EADDRINUSE') return true;
  }
  return false;
}

/** Connects the way the UI does and waits for the greeting a Capybara server sends every viewer. */
export async function isCapybaraServer(port: number, timeout = 2_000): Promise<boolean> {
  return (await readServerInfo(port, timeout)) !== undefined;
}

/** What the Capybara server on `port` says of itself in that greeting; undefined when no Capybara answers. */
export function readServerInfo(port: number, timeout = 2_000): Promise<ServerInfo | undefined> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}${VIEWER_PATH}`, { origin: `http://localhost:${port}` });
    const finish = (result: ServerInfo | undefined) => {
      clearTimeout(timer);
      ws.removeAllListeners();
      // Terminating a socket that is still connecting emits one more error.
      ws.on('error', () => {});
      ws.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish(undefined), timeout);
    ws.once('message', (data) => finish(greeting(data)));
    ws.once('error', () => finish(undefined));
  });
}

function greeting(data: RawData): ServerInfo | undefined {
  try {
    const message = JSON.parse(data.toString()) as { t?: unknown; server?: ServerInfo };
    return message.t === 'init' && message.server && typeof message.server === 'object' ? message.server : undefined;
  } catch {
    return undefined;
  }
}
