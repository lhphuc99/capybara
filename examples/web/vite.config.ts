import type { IncomingMessage, ServerResponse } from 'node:http';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { WebSocketServer } from 'ws';

const users = [
  { id: 1, name: 'Ada Lovelace', email: 'ada@example.com', role: 'admin' },
  { id: 2, name: 'Alan Turing', email: 'alan@example.com', role: 'editor' },
  { id: 3, name: 'Grace Hopper', email: 'grace@example.com', role: 'viewer' },
];

/** A small fake backend so the demo works without a network connection. */
function mockApi(): Plugin {
  return {
    name: 'mock-api',
    configureServer(server) {
      server.middlewares.use('/api', (req, res) => {
        void handle(req, res);
      });
      const sockets = new WebSocketServer({ noServer: true });
      sockets.on('connection', (socket) => {
        socket.send(JSON.stringify({ type: 'welcome', users: users.length }));
        socket.on('message', (data, isBinary) => {
          if (isBinary) socket.send(data, { binary: true });
          else socket.send(JSON.stringify({ type: 'echo', received: safeParse(data.toString()) }));
        });
      });
      // Vite's own HMR socket handles its upgrades separately, by subprotocol.
      server.httpServer?.on('upgrade', (req, socket, head) => {
        if (req.url?.startsWith('/api/socket')) sockets.handleUpgrade(req, socket, head, (ws) => sockets.emit('connection', ws, req));
      });
    },
  };
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'x-request-id': Math.random().toString(36).slice(2, 10),
      ...headers,
    });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === '/users') return json(200, users);
  const userMatch = /^\/users\/(\d+)$/.exec(url.pathname);
  if (userMatch) {
    const user = users.find((u) => u.id === Number(userMatch[1]));
    return user ? json(200, user) : json(404, { error: 'User not found' });
  }
  if (url.pathname === '/login' && req.method === 'POST') {
    const body = await readBody(req);
    return json(
      200,
      { token: 'eyJhbGciOiJIUzI1NiJ9.demo.signature', user: users[0], received: safeParse(body) },
      { 'set-cookie': 'session=abc123; Path=/; HttpOnly' },
    );
  }
  if (url.pathname === '/slow') {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    return json(200, { ok: true, waitedMs: 1_500 });
  }
  if (url.pathname === '/error') return json(500, { error: 'Internal Server Error', code: 'E_DB_TIMEOUT' });
  return json(404, { error: `No mock for ${req.method} ${url.pathname}` });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export default defineConfig({
  plugins: [react(), mockApi()],
});
