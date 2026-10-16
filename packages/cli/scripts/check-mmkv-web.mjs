// End-to-end test of react-native-mmkv on the web through the Capybara web SDK, against the isolated
// fixture apps served by `npx expo start` (react-native-web), never a user's app.
// Build Capybara first, start a fixture's Metro, then run this script with the fixture's web URL.
// Uses headless Google Chrome; set CHROME to its executable if it is not in the default macOS location.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';
import { WebSocket } from 'ws';
import { createServer } from '../dist/server.js';

const url = process.argv[2] ?? 'http://localhost:8095';
const reportFile = process.argv[3];
const chromePath = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const fixtures = ['Capybara MMKV Test', 'Capybara MMKV3 Test'];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  do { const result = await fn(); if (result) return result; await delay(100); } while (Date.now() < deadline);
  throw new Error('Timed out waiting for fixture');
}

const sdkBundle = await rolldown({ input: fileURLToPath(new URL('../../web/dist/index.js', import.meta.url)), platform: 'browser' });
const sdk = (await sdkBundle.generate({ format: 'iife', name: 'CapybaraWeb' })).output[0].code;
await sdkBundle.close();

const report = { url, checks: [] };
const pass = (name) => { report.checks.push(name); console.log('PASS ' + name); };
const server = createServer({ port: 0, host: '127.0.0.1' });
const { port } = await server.start();
const viewer = new WebSocket(`ws://127.0.0.1:${port}/viewer`, { origin: `http://127.0.0.1:${port}` });
const messages = [];
viewer.on('message', (data) => messages.push(JSON.parse(data.toString())));
await new Promise((resolve, reject) => { viewer.once('open', resolve); viewer.once('error', reject); });

const profile = mkdtempSync(join(tmpdir(), 'capybara-chrome-'));
const chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
let cdp;
try {
  const devtoolsPort = await until(() => { try { return Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { return undefined; } }, 10_000);
  const page = (await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json()).find((target) => target.type === 'page');
  cdp = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { cdp.once('open', resolve); cdp.once('error', reject); });
  const pending = new Map();
  let nextId = 0;
  cdp.on('message', (data) => { const message = JSON.parse(data.toString()); if (message.id) pending.get(message.id)?.(message); });
  const call = (method, params = {}) => new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); cdp.send(JSON.stringify({ id, method, params })); });
  async function inPage(expression) {
    const reply = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    assert.equal(reply.result?.exceptionDetails, undefined, reply.result?.exceptionDetails?.exception?.description);
    return reply.result.result.value;
  }
  const appName = `MMKV web fixture ${Date.now()}`;
  await call('Page.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `${sdk}\nCapybaraWeb.init({ appName: ${JSON.stringify(appName)}, host: '127.0.0.1', port: ${port} });` });
  await call('Page.navigate', { url });
  const session = await until(() => messages.find((m) => m.t === 'session' && m.session.info.appName === appName && m.session.connected), 120_000);
  report.title = await inPage('document.title');
  assert.ok(fixtures.includes(report.title), 'Only the isolated Capybara fixture apps may be used');
  const fixture = `[...globalThis.__r.getModules().values()].find(m => m.isInitialized && (m.verboseName ?? '').endsWith('scenarios.ts')).publicModule.exports`;
  await until(() => inPage(`typeof globalThis.__r?.getModules === 'function' && [...globalThis.__r.getModules().values()].some(m => m.isInitialized && (m.verboseName ?? '').endsWith('scenarios.ts'))`), 60_000);
  const sessionId = session.session.info.id;
  const events = () => messages.filter((m) => m.t === 'events' && m.sessionId === sessionId).flatMap((m) => m.events);
  async function command(method, params) {
    const id = `web-${++nextId}`;
    viewer.send(JSON.stringify({ t: 'command', id, sessionId, plugin: 'storage', method, params }));
    const reply = await until(() => messages.find((m) => m.t === 'result' && m.id === id));
    assert.equal(reply.ok, true, reply.error);
    return reply.result;
  }

  // react-native-mmkv keeps web values as text in localStorage under `<id>\<key>`.
  const key = (name) => `capybara-fixture-exported\\${name}`;
  const local = (await command('list')).find((store) => store.id === 'localStorage');
  assert.ok(local);
  const values = Object.fromEntries((await command('entries', { adapter: local.id })).entries.map((entry) => [entry.key, entry.value]));
  assert.equal(values[key('message')], 'exported native store');
  assert.equal(values[key('unicode')], 'Xin chào 😀');
  assert.equal(JSON.parse(values[key('json')]).fixture, true);
  assert.deepEqual([values[key('count')], values[key('ratio')], values[key('enabled')], values[key('visible')]], ['42', '3.14', 'false', 'true']);
  assert.equal(values[key('emoji 😀')], 'astral key');
  assert.equal(values['capybara-fixture-private-before\\message'], 'private before connection');
  pass('MMKV web values are listed in Local Storage with exact text, including numbers, booleans and an emoji key');
  assert.equal(values['capybara-fixture-async'], 'native AsyncStorage');
  pass('AsyncStorage web values are listed next to them');

  await command('set', { adapter: local.id, key: key('message'), value: 'edited from Capybara' });
  assert.equal(await inPage(`${fixture}.exportedStore.getString('message')`), 'edited from Capybara');
  pass('an edit made in Capybara is read back by the app through MMKV');
  const before = events().filter((event) => event.kind === 'storage.change').length;
  await inPage(`${fixture}.exportedStore.set('count', 7)`);
  await until(() => events().filter((event) => event.kind === 'storage.change').slice(before).some((event) => event.payload.key === key('count')));
  assert.equal((await command('get', { adapter: local.id, key: key('count') })).value, '7');
  pass('an app-side MMKV write emits a storage change and reads back');

  await inPage(`(() => { console.log('mmkv-web-check', new Map([['k', 1]])); return fetch('/status').then(r => r.status); })()`);
  await until(() => {
    const all = events();
    const request = all.find((event) => event.kind === 'network.request' && event.payload.url.endsWith('/status'));
    return all.some((event) => event.kind === 'log' && JSON.stringify(event.payload.args).includes('mmkv-web-check')) &&
      request && all.some((event) => event.kind === 'network.response' && event.payload.id === request.payload.id && event.payload.status === 200);
  });
  pass('logs and fetch from the same page are captured');
  report.completedAt = new Date().toISOString();
  if (reportFile) writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  cdp?.close();
  chrome.kill();
  viewer.terminate();
  await server.close();
  await delay(300);
  rmSync(profile, { recursive: true, force: true });
}
