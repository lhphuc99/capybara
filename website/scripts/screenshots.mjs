// Captures the Capybara UI showing made-up apps, for the website. Needs the product built
// (`npm run build`) and Google Chrome. Writes WebP files into src/assets/screenshots/, then
// renders the link preview card (scripts/og.html) into public/og.png.
//   node scripts/screenshots.mjs [scene ...]   scenes: network, why, logs, storage, state, og (default: all)
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { delay, launchChrome, until } from './chrome.mjs';
import { apps } from './demo-data.mjs';

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const serverModule = path('../../packages/cli/dist/server.js');
const protocolModule = path('../../packages/protocol/dist/index.js');
const uiDir = path('../../packages/ui/dist/');
const outDir = path('../src/assets/screenshots/');

for (const required of [serverModule, protocolModule, uiDir]) {
  if (!existsSync(required)) {
    console.error(`[website] ${required} not found. Run \`npm run build\` from the repo root first.`);
    process.exit(1);
  }
}
const { createServer } = await import(serverModule);
const { PROTOCOL_VERSION } = await import(protocolModule);

// The hero shows the whole window; the rest sit in feature cards, so they are shorter.
const scenes = {
  network: {
    app: apps.web,
    height: 800,
    async show(page) {
      await page.click('.tabs [role=tab]', 'Network');
      await page.click('.net-row', '/api/products?');
      await page.click('.subtabs [role=tab]', 'Response');
      await page.click('.tree-branch', '0: {id');
    },
  },
  why: {
    app: apps.web,
    height: 620,
    // The server repeats the failed request, so it needs a real API without CORS headers to talk to.
    needsRewardsApi: true,
    async show(page) {
      await page.click('.tabs [role=tab]', 'Network');
      await page.click('.net-row', '/api/rewards');
      await page.click('.subtabs [role=tab]', 'Response');
      await page.click('button', 'Find out why');
      await page.waitFor('.diagnosis');
    },
  },
  logs: {
    app: apps.native,
    height: 620,
    async show(page) {
      await page.click('.tabs [role=tab]', 'Logs');
      await page.click('.log-line.clickable', 'TypeError');
    },
  },
  storage: {
    app: apps.nativeWithSdk,
    height: 620,
    async show(page) {
      await page.click('.tabs [role=tab]', 'Storage');
      await page.click('.entry-row', 'settings');
      await delay(300);
    },
  },
  state: {
    app: apps.webWithState,
    height: 620,
    async show(page) {
      await page.click('.tabs [role=tab]', 'State');
      await page.click('.entry-row', '09:41:14.280');
      await page.waitFor('.diff-op');
    },
  },
};

const requested = process.argv.slice(2);
const unknown = requested.filter((name) => !(name in scenes) && name !== 'og');
if (unknown.length) {
  console.error(`Unknown scene: ${unknown.join(', ')}. Scenes: ${Object.keys(scenes).join(', ')}`);
  process.exit(1);
}

/** Connects like an app with the SDK: hello, wait for welcome, send its events, answer commands. */
async function connectApp(port, { session, events, answer }) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/client`);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const welcomed = new Promise((resolve) => {
    socket.on('message', (data) => {
      const message = JSON.parse(String(data));
      if (message.t === 'welcome') resolve();
      if (message.t !== 'command') return;
      try {
        const result = answer ? answer(message.method, message.params, message.plugin) : null;
        socket.send(JSON.stringify({ t: 'result', id: message.id, ok: true, result }));
      } catch (error) {
        socket.send(JSON.stringify({ t: 'result', id: message.id, ok: false, error: error.message }));
      }
    });
  });
  socket.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, session }));
  await welcomed;
  socket.send(JSON.stringify({ t: 'events', events }));
  return socket;
}

function startRewardsApi() {
  const api = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"points":120}');
  });
  return new Promise((resolve, reject) => {
    api.once('error', (error) =>
      reject(error.code === 'EADDRINUSE' ? new Error('Port 4000 is in use; the "why" scene needs it for its demo API.') : error),
    );
    // `::` takes both IPv4 and IPv6, whichever `localhost` resolves to for the server.
    api.listen(4000, '::', () => resolve(api));
  });
}

mkdirSync(outDir, { recursive: true });
const chrome = await launchChrome();
try {
  for (const [name, scene] of Object.entries(scenes)) {
    if (requested.length && !requested.includes(name)) continue;
    const api = scene.needsRewardsApi ? await startRewardsApi() : undefined;
    try {
      for (const dark of [false, true]) {
        // A fresh server per capture gives a new origin, so no tab or pane width is remembered from the last one.
        const server = createServer({ port: 0, host: '127.0.0.1', uiDir, version: '0.1.0' });
        const { port } = await server.start();
        const app = await connectApp(port, scene.app);
        const page = await chrome.newPage();
        try {
          await page.emulate({ width: 1280, height: scene.height, scale: 2, dark });
          await page.goto(`http://127.0.0.1:${port}/`);
          await page.waitFor('.tabs [role=tab]');
          await scene.show(page);
          await until(() => page.evaluate('!document.querySelector(".empty")'), 'the panel to load');
          const theme = dark ? 'dark' : 'light';
          writeFileSync(`${outDir}${name}-${theme}@2x.webp`, await page.capture({ quality: 88 }));
          await page.emulate({ width: 1280, height: scene.height, scale: 1, dark });
          await delay(200);
          writeFileSync(`${outDir}${name}-${theme}.webp`, await page.capture({ quality: 90 }));
          console.log(`${name} ${theme}`);
        } finally {
          page.close();
          app.close();
          await server.close();
        }
      }
    } finally {
      api?.close();
    }
  }
  if (!requested.length || requested.includes('og')) {
    const page = await chrome.newPage();
    await page.emulate({ width: 1200, height: 630 });
    await page.goto(`file://${path('og.html')}`);
    await until(() => page.evaluate('[...document.images].every((image) => image.complete)'), 'the preview card images');
    mkdirSync(path('../public/'), { recursive: true });
    writeFileSync(path('../public/og.png'), await page.capture({ format: 'png' }));
    page.close();
    console.log('og');
  }
} finally {
  await chrome.close();
}
