#!/usr/bin/env node
// The API the example app calls, on this computer only (the Android emulator reaches it at 10.0.2.2).
// Prints one JSON line per request with the sha256 of each body, so a test can check that what Capybara
// shows is byte for byte what went over the wire.
//
//   node dart/example/tool/mock_server.mjs [--port 4100]

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { WebSocketServer } from 'ws';

const { values } = parseArgs({ options: { port: { type: 'string', default: '4100' } } });
const port = Number(values.port);

// A 1×1 PNG: image requests only need to decode.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function jsonOfSize(size) {
  const items = [];
  let length = 12;
  for (let id = 0; length < size; id++) {
    const item = { id, name: `Item ${id}`, price: (id * 7) % 100, tags: ['yuzu', 'onsen'] };
    length += JSON.stringify(item).length + 1;
    items.push(item);
  }
  return Buffer.from(JSON.stringify({ items }));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
  const body = await readBody(request);
  let status = 200;
  let type = 'application/json';
  let out;
  if (request.method === 'GET' && url.pathname === '/json') {
    out = jsonOfSize(Number(url.searchParams.get('size') ?? 1024));
  } else if (request.method === 'POST' && url.pathname === '/echo') {
    type = request.headers['content-type'] ?? 'application/octet-stream';
    out = body;
  } else if (request.method === 'POST' && url.pathname === '/upload') {
    out = Buffer.from(JSON.stringify({ bytes: body.length, sha256: sha256(body) }));
  } else if (url.pathname.startsWith('/status/')) {
    status = Number(url.pathname.slice('/status/'.length)) || 500;
    out = Buffer.from(JSON.stringify({ status }));
  } else if (url.pathname === '/slow') {
    await new Promise((resolve) => setTimeout(resolve, Number(url.searchParams.get('ms') ?? 1000)));
    out = Buffer.from(JSON.stringify({ slow: true }));
  } else if (url.pathname === '/image') {
    type = 'image/png';
    out = PNG;
  } else {
    status = 404;
    out = Buffer.from(JSON.stringify({ error: 'Not found' }));
  }
  const headers = { 'content-type': type, 'cache-control': 'no-store', 'x-mock': 'capybara' };
  // gzip=1 compresses when the client accepts it, to check that the decoded body is what gets shown.
  let sent = out;
  if (url.searchParams.get('gzip') === '1' && /\bgzip\b/.test(request.headers['accept-encoding'] ?? '')) {
    sent = gzipSync(out);
    headers['content-encoding'] = 'gzip';
  }
  response.writeHead(status, headers);
  response.end(sent);
  console.log(
    JSON.stringify({
      method: request.method,
      url: url.pathname + url.search,
      status,
      requestBytes: body.length,
      requestSha256: body.length ? sha256(body) : undefined,
      responseBytes: out.length,
      responseSha256: sha256(out),
    }),
  );
});

const sockets = new WebSocketServer({ server, path: '/ws' });
sockets.on('connection', (socket) => {
  console.log(JSON.stringify({ ws: 'open' }));
  socket.on('message', (data, isBinary) => {
    console.log(JSON.stringify({ ws: 'message', binary: isBinary, bytes: data.length }));
    socket.send(data, { binary: isBinary });
  });
  socket.on('close', (code) => console.log(JSON.stringify({ ws: 'close', code })));
});

server.listen(port, '127.0.0.1', () => console.error(`Mock API on http://127.0.0.1:${port}`));
