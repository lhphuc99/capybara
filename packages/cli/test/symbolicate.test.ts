import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CapybaraEvent } from '@capybara-devtools/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createServer } from '../src/server.js';
import { localWebOrigin, needsSymbolication, symbolicateEvents } from '../src/symbolicate.js';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface MetroFrame {
  file: string;
  lineNumber: number;
  column: number;
  methodName?: string;
}

/** Answers `/symbolicate` the way Metro does: mapped frames get a source file, the rest come back as sent. */
async function fakeMetro(sources: Record<number, MetroFrame>, options: { delay?: number; status?: number } = {}) {
  const requests: MetroFrame[][] = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.method !== 'POST' || req.url !== '/symbolicate') return void res.writeHead(404).end();
    const { stack } = JSON.parse(body) as { stack: MetroFrame[] };
    requests.push(stack);
    await new Promise((resolve) => setTimeout(resolve, options.delay ?? 0));
    if (options.status) return void res.writeHead(options.status).end('{"error":"boom"}');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ codeFrame: null, stack: stack.map((frame) => ({ ...frame, ...sources[frame.lineNumber] })) }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return { port: (server.address() as AddressInfo).port, requests };
}

const APP: Record<number, MetroFrame> = {
  86171: { file: '/Users/dev/app/App.tsx', lineNumber: 42, column: 12, methodName: 'onPress' },
  90210: { file: '/Users/dev/app/src/api.ts', lineNumber: 7, column: 0, methodName: 'loadUser' },
};

const bundle = (port: number, host = 'localhost') =>
  `http://${host}:${port}/index.bundle//&platform=ios&dev=true&lazy=true&minify=false&app=dev.capybara.test`;

const error = (stack: string, props?: Record<string, unknown>) => ({ $t: 'error', name: 'Error', message: 'boom', stack, ...(props && { props }) });

const logOf = (seq: number, ...args: unknown[]) =>
  ({ seq, ts: seq, kind: 'log', payload: { level: 'error', source: 'console', args } }) as unknown as CapybaraEvent;

const stackOf = (event: CapybaraEvent, path: (args: any[]) => any = (args) => args[0]) =>
  (path((event.payload as { args: any[] }).args) as { stack: string }).stack;

describe('symbolicateEvents', () => {
  it('maps Hermes frames into a Metro bundle back to source, and leaves the others', async () => {
    const metro = await fakeMetro(APP);
    const url = bundle(metro.port);
    const event = logOf(1, error([
      'Error: boom',
      `    at onPress (${url}:86171:28)`,
      `    at anonymous (${url}:500:3)`,
      '    at apply (native)',
    ].join('\n')));
    expect(needsSymbolication([event])).toBe(true);

    await symbolicateEvents([event]);

    expect(stackOf(event)).toBe([
      'Error: boom',
      '    at onPress (/Users/dev/app/App.tsx:42:13)',
      `    at anonymous (${url}:500:3)`,
      '    at apply (native)',
    ].join('\n'));
    // Metro takes the URL as the app saw it and 0-based columns.
    expect(metro.requests).toEqual([[
      { file: url, lineNumber: 86171, column: 27, methodName: 'onPress' },
      { file: url, lineNumber: 500, column: 2, methodName: 'anonymous' },
    ]]);
  });

  it('finds errors anywhere in the arguments and reads V8 and JSC frames, in one request per Metro', async () => {
    const metro = await fakeMetro(APP);
    const url = bundle(metro.port);
    const cause = error(`loadUser@${url}:90210:5`);
    const event = logOf(
      1,
      'Request failed',
      { $t: 'object', name: 'Response', props: { error: error(`Error: boom\n    at ${url}:86171:28`, { cause }) } },
    );

    await symbolicateEvents([event]);

    expect(stackOf(event, (args) => args[1].props.error)).toBe('Error: boom\n    at onPress (/Users/dev/app/App.tsx:42:13)');
    expect(stackOf(event, (args) => args[1].props.error.props.cause)).toBe('loadUser@/Users/dev/app/src/api.ts:7:1');
    expect(metro.requests).toHaveLength(1);
  });

  it('asks Metro on localhost for bundles an Android emulator loaded from 10.0.2.2', async () => {
    const metro = await fakeMetro(APP);
    const event = logOf(1, error(`Error: boom\n    at onPress (${bundle(metro.port, '10.0.2.2')}:86171:28)`));
    await symbolicateEvents([event]);
    expect(stackOf(event)).toBe('Error: boom\n    at onPress (/Users/dev/app/App.tsx:42:13)');
  });

  it('leaves stacks from other machines, and stacks Metro fails or is too slow to map, as they were', async () => {
    const metro = await fakeMetro(APP);
    const elsewhere = `Error: boom\n    at onPress (${bundle(metro.port, '203.0.113.9')}:86171:28)`;
    const remote = logOf(1, error(elsewhere));
    await symbolicateEvents([remote]);
    expect(stackOf(remote)).toBe(elsewhere);
    expect(metro.requests).toHaveLength(0);

    const failing = await fakeMetro(APP, { status: 500 });
    const failed = `Error: boom\n    at onPress (${bundle(failing.port)}:86171:28)`;
    const event = logOf(1, error(failed));
    await symbolicateEvents([event]);
    expect(stackOf(event)).toBe(failed);

    const slow = await fakeMetro(APP, { delay: 1_000 });
    const late = `Error: boom\n    at onPress (${bundle(slow.port)}:86171:28)`;
    const lateEvent = logOf(1, error(late));
    await symbolicateEvents([lateEvent], { timeout: 100 });
    expect(stackOf(lateEvent)).toBe(late);
  });

  it('skips events without bundle frames, and payloads of any shape', async () => {
    const plain = [
      logOf(1, 'hello', error('Error: boom\n    at http://localhost:5173/src/App.tsx:3:7')),
      logOf(2, { $t: 'array', items: null }, { $t: 'map', entries: [null, [1]] }, { $t: 'error', stack: 42 }),
      { seq: 3, ts: 3, kind: 'log', payload: null } as unknown as CapybaraEvent,
    ];
    expect(needsSymbolication(plain)).toBe(false);
    await expect(symbolicateEvents(plain)).resolves.toBeUndefined();
  });
});

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** One source map segment, as base64 VLQ. */
function segment(...fields: number[]): string {
  return fields
    .map((field) => {
      let value = field < 0 ? (-field << 1) | 1 : field << 1;
      let out = '';
      do {
        let digit = value & 31;
        value >>>= 5;
        if (value > 0) digit |= 32;
        out += BASE64[digit];
      } while (value > 0);
      return out;
    })
    .join('');
}

/** A dev server with a Vite-style module (inline map) and a Next.js-style chunk (sectioned map in a file). */
async function fakeDevServer() {
  const requested: string[] = [];
  const appMap = { version: 3, sources: ['App.tsx'], names: [], mappings: `;;${segment(4, 0, 48, 42)}` };
  const pageMap = {
    version: 3,
    sections: [{ offset: { line: 0, column: 0 }, map: { version: 3, sources: ['file:///Users/dev/shop/app/page.tsx'], names: ['onClick'], mappings: `;${segment(10, 0, 30, 70, 0)}` } }],
  };
  const files: Record<string, string> = {
    '/src/App.tsx': `const a = 1;\nconst b = 2;\nexport function run() {}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(appMap)).toString('base64')}`,
    '/_next/static/chunks/page.js': 'var x;\nfunction handle() {}\n//# sourceMappingURL=page.js.map',
    '/_next/static/chunks/page.js.map': JSON.stringify(pageMap),
    '/src/elsewhere.js': 'x();\n//# sourceMappingURL=http://cdn.example.test/elsewhere.js.map',
  };
  const server = http.createServer((req, res) => {
    requested.push(req.url ?? '');
    const file = files[req.url ?? ''];
    if (file === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': req.url?.endsWith('.map') ? 'application/json' : 'text/javascript' }).end(file);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requested };
}

describe('web stacks through the source maps of the dev server', () => {
  it('maps frames of Vite modules and Next.js chunks to their sources, and leaves the rest', async () => {
    const dev = await fakeDevServer();
    const stack = [
      'Error: Card declined',
      `    at run (${dev.origin}/src/App.tsx:3:5)`,
      `    at ${dev.origin}/_next/static/chunks/page.js:2:11`,
      `    at load (${dev.origin}/admin/delete:1:1)`,
      `    at lib (http://cdn.example.test/lib.js:1:1)`,
      `    at other (${dev.origin}/src/elsewhere.js:1:1)`,
    ].join('\n');
    const event = logOf(1, 'Payment failed', error(stack));
    expect(needsSymbolication([event])).toBe(false);
    expect(needsSymbolication([event], dev.origin)).toBe(true);
    await symbolicateEvents([event], { webOrigin: dev.origin });
    expect(((event.payload as { args: Array<{ stack?: string }> }).args[1]!.stack ?? '').split('\n')).toEqual([
      'Error: Card declined',
      '    at run (src/App.tsx:49:43)',
      '    at onClick (/Users/dev/shop/app/page.tsx:31:71)',
      `    at load (${dev.origin}/admin/delete:1:1)`,
      '    at lib (http://cdn.example.test/lib.js:1:1)',
      `    at other (${dev.origin}/src/elsewhere.js:1:1)`,
    ]);
    // Only scripts of the page's own origin, and maps on it.
    expect(dev.requested.sort()).toEqual(['/_next/static/chunks/page.js', '/_next/static/chunks/page.js.map', '/src/App.tsx', '/src/elsewhere.js']);
  });

  it('takes the origin of web apps whose dev server runs on this machine', () => {
    const info = { id: 'w', appName: 'Shop', platform: 'web' as const, sdk: { name: 'test', version: '0' }, startedAt: 0 };
    expect(localWebOrigin({ ...info, url: 'http://localhost:5173/cart?x=1' })).toBe('http://localhost:5173');
    expect(localWebOrigin({ ...info, url: 'https://shop.example.com/' })).toBeUndefined();
    expect(localWebOrigin({ ...info, platform: 'ios', url: 'http://localhost:8081/' })).toBeUndefined();
    expect(localWebOrigin(info)).toBeUndefined();
  });
});

describe('server: stacks of React Native errors', () => {
  async function relay() {
    const server = createServer({ port: 0, host: '127.0.0.1', version: 'test' });
    const { port } = await server.start();
    cleanups.push(() => server.close());
    const open = (path: string, headers: Record<string, string> = {}) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
      cleanups.push(() => ws.terminate());
      const messages: any[] = [];
      ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
      return { ws, messages, opened: new Promise((resolve) => ws.once('open', resolve)) };
    };
    const viewer = open('/viewer', { origin: `http://127.0.0.1:${port}` });
    const app = open('/client');
    await Promise.all([viewer.opened, app.opened]);
    app.ws.send(JSON.stringify({ t: 'hello', protocol: 1, session: { id: 'app-1', appName: 'Shop', platform: 'ios', sdk: { name: 'test', version: '0' }, startedAt: 1 } }));
    await vi.waitFor(() => expect(app.messages.some((m) => m.t === 'welcome')).toBe(true));
    const send = (...events: CapybaraEvent[]) => app.ws.send(JSON.stringify({ t: 'events', events }));
    return { viewer, send };
  }

  it('maps them before passing them on, keeping later events behind them', async () => {
    const metro = await fakeMetro(APP, { delay: 150 });
    const { viewer, send } = await relay();
    send(logOf(1, error(`Error: boom\n    at onPress (${bundle(metro.port)}:86171:28)`)));
    send(logOf(2, 'after the error'));

    await vi.waitFor(() => expect(viewer.messages.filter((m) => m.t === 'events')).toHaveLength(2), { timeout: 2_000 });
    const batches = viewer.messages.filter((m) => m.t === 'events');
    expect(batches.map((batch) => batch.events[0].seq)).toEqual([1, 2]);
    expect(stackOf(batches[0].events[0])).toBe('Error: boom\n    at onPress (/Users/dev/app/App.tsx:42:13)');
  });

  it('clears an error that was waiting for Metro when the clear came', async () => {
    const metro = await fakeMetro(APP, { delay: 150 });
    const { viewer, send } = await relay();
    send(logOf(1, error(`Error: boom\n    at onPress (${bundle(metro.port)}:86171:28)`)));
    await vi.waitFor(() => expect(metro.requests).toHaveLength(1));
    viewer.ws.send(JSON.stringify({ t: 'clear', sessionId: 'app-1' }));

    await vi.waitFor(() => expect(viewer.messages.some((m) => m.t === 'cleared')).toBe(true), { timeout: 2_000 });
    expect(viewer.messages.filter((m) => m.t === 'events' || m.t === 'cleared').map((m) => m.t)).toEqual(['events', 'cleared']);
    viewer.ws.send(JSON.stringify({ t: 'history', sessionId: 'app-1' }));
    await vi.waitFor(() => expect(viewer.messages.find((m) => m.t === 'history')?.events).toEqual([]));
  });
});
