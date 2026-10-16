import { createReadStream, statSync, type Stats } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const PLACEHOLDER = `<!doctype html>
<meta charset="utf-8">
<title>Capybara</title>
<body style="font: 15px system-ui; margin: 40px; color: #333">
<h1 style="font-size: 20px">Capybara server is running</h1>
<p>The UI has not been built. Run <code>npm run build -w @capybara-devtools/ui</code>, then <code>npm run build -w capybara-devtools</code>.</p>
</body>`;

export function serveStatic(req: IncomingMessage, res: ServerResponse, root: string | undefined): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  if (!root) {
    res.writeHead(200, { 'content-type': MIME['.html']! }).end(PLACEHOLDER);
    return;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }

  const base = resolve(root);
  let file = resolve(base, `.${pathname}`);
  if (file !== base && !file.startsWith(base + sep)) {
    res.writeHead(403).end();
    return;
  }

  let stats = tryStat(file);
  if (stats?.isDirectory()) {
    file = join(file, 'index.html');
    stats = tryStat(file);
  }
  // Client-side routes have no extension and fall back to the app shell.
  if (!stats && !extname(pathname)) {
    file = join(base, 'index.html');
    stats = tryStat(file);
  }
  if (!stats) {
    res.writeHead(404, { 'content-type': MIME['.txt']! }).end('Not found');
    return;
  }

  // Vite fingerprints everything under assets/, so those can be cached forever.
  const immutable = file.startsWith(join(base, 'assets') + sep);
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'content-length': stats.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

function tryStat(file: string): Stats | undefined {
  try {
    return statSync(file);
  } catch {
    return undefined;
  }
}
