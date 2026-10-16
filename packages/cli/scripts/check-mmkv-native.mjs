// End-to-end test against the isolated Devsight fixture apps on a simulator, never a user's app.
// Build CLI first, launch test/native-fixture (MMKV 4, Metro port 8095) or
// test/native-fixture-mmkv3 (MMKV 3, port 8096), then run this script with that port.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { createServer, startMetroBridge } from '../dist/server.js';

const metroPort = Number(process.argv[2] ?? 8095);
const reportFile = process.argv[3];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  do { const result = await fn(); if (result) return result; await delay(50); } while (Date.now() < deadline);
  throw new Error('Timed out waiting for fixture');
}
const fixtures = { 'dev.devsight.mmkvtest': 4, 'dev.devsight.mmkv3test': 3 };
const targets = await (await fetch(`http://localhost:${metroPort}/json/list`)).json();
const target = targets.find(item => Object.hasOwn(fixtures, item.appId));
assert.ok(target, 'Only the isolated Devsight fixture apps may be used');
assert.ok(target.reactNative?.capabilities?.supportsMultipleDebuggers);
const mmkvMajor = fixtures[target.appId];
const cdp = new WebSocket(target.webSocketDebuggerUrl, { origin: `http://127.0.0.1:${metroPort}`, handshakeTimeout: 3_000 });
const pending = new Map();
let nextId = 0;
cdp.on('message', data => {
  const message = JSON.parse(data.toString());
  if (message.id) pending.get(message.id)?.(message);
});
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 5_000);
    pending.set(id, message => {
      clearTimeout(timer); pending.delete(id);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    });
    cdp.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const reply = await call('Runtime.evaluate', { expression: `JSON.stringify(${expression})`, returnByValue: true });
  assert.equal(reply.exceptionDetails, undefined, reply.exceptionDetails?.text);
  return reply.result.value === undefined ? undefined : JSON.parse(reply.result.value);
}
async function action(name) {
  const expression = `(() => {
    const state = {done: false};
    const module = [...globalThis.__r.getModules().values()].find(m => m.isInitialized && (m.verboseName ?? '').endsWith('scenarios.ts') && typeof m.publicModule?.exports?.runTestAction === 'function');
    if (!module) throw new Error('Fixture module not found');
    Promise.resolve(module.publicModule.exports.runTestAction(${JSON.stringify(name)})).then(
      value => {state.value = value; state.done = true;},
      error => {state.error = String(error); state.done = true;});
    return state;
  })()`;
  const reply = await call('Runtime.evaluate', { expression, returnByValue: false });
  assert.equal(reply.exceptionDetails, undefined, reply.exceptionDetails?.text);
  const objectId = reply.result.objectId;
  assert.ok(objectId);
  try {
    const state = await until(async () => {
      const result = await call('Runtime.callFunctionOn', { objectId, functionDeclaration: 'function () { return JSON.stringify(this); }', returnByValue: true });
      const value = JSON.parse(result.result.value);
      return value.done ? value : undefined;
    });
    assert.equal(state.error, undefined);
    return state.value;
  } finally { await call('Runtime.releaseObject', { objectId }); }
}
const factoryHasShadow = `(() => {
  const module = [...globalThis.__r.getModules().values()].find(m => m.isInitialized && /getMMKVFactory\\.[jt]s$/.test(m.verboseName ?? ''));
  return module ? Object.prototype.hasOwnProperty.call(module.publicModule.exports.getMMKVFactory(), 'createMMKV') : null;
})()`;
const mmkvClass = `[...globalThis.__r.getModules().values()].find(m => m.isInitialized && /react-native-mmkv\\/src\\/MMKV\\.ts$/.test(m.verboseName ?? '')).publicModule.exports.MMKV`;
// V3 wraps a method that stays an own property of the prototype, so only identity tells the
// original from the wrapper. Keep a CDP handle to the original instead of storing it in the app.
let originalMethod;
async function hooked() {
  if (mmkvMajor === 4) return evaluate(factoryHasShadow);
  const reply = await call('Runtime.callFunctionOn', {
    objectId: originalMethod,
    functionDeclaration: `function () { return ${mmkvClass}.prototype.getFunctionFromCache !== this; }`,
    returnByValue: true,
  });
  assert.equal(reply.exceptionDetails, undefined, reply.exceptionDetails?.text);
  return reply.result.value;
}
let bridge, server, viewer;
const report = { app: target.appId, mmkv: mmkvMajor, metroPort, checks: [], limitations: [] };
const pass = name => { report.checks.push(name); console.log('PASS ' + name); };
try {
  await new Promise((resolve, reject) => { cdp.once('open', resolve); cdp.once('error', reject); });
  // Hermes rejects object handles (callFunctionOn, releaseObject) until Runtime is enabled per session.
  await call('Runtime.enable');
  assert.equal(await evaluate('typeof globalThis.__DEVSIGHT_CLIENT__'), 'undefined');
  assert.equal(await evaluate('typeof globalThis.__DEVSIGHT_MMKV_TRACKER_V1__'), 'undefined');
  if (mmkvMajor === 3) {
    assert.equal(await evaluate(`${mmkvClass}.prototype.getFunctionFromCache.name`), 'getFunctionFromCache');
    originalMethod = (await call('Runtime.evaluate', { expression: `${mmkvClass}.prototype.getFunctionFromCache`, returnByValue: false })).result.objectId;
    assert.ok(originalMethod);
  }
  assert.equal(await hooked(), false);
  pass('fixture has no Devsight SDK or preinstalled tracker');

  server = createServer({ port: 0, host: '127.0.0.1' });
  const { port } = await server.start();
  viewer = new WebSocket(`ws://127.0.0.1:${port}/viewer`, { origin: `http://127.0.0.1:${port}` });
  const messages = [];
  viewer.on('message', data => messages.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => { viewer.once('open', resolve); viewer.once('error', reject); });
  bridge = startMetroBridge({ port, metroPorts: [metroPort] });
  const session = await until(() => messages.find(m => m.t === 'session' && m.session.connected));
  report.runtime = session.session.info.runtime;
  report.device = session.session.info.device;
  async function command(method, params, expectError = false) {
    const id = `native-${++nextId}`;
    viewer.send(JSON.stringify({ t: 'command', id, sessionId: session.session.info.id, plugin: 'storage', method, params }));
    const reply = await until(() => messages.find(m => m.t === 'result' && m.id === id));
    assert.equal(reply.ok, !expectError, reply.error);
    return expectError ? reply.error : reply.result;
  }
  await until(async () => await hooked() === true);
  pass(mmkvMajor === 4 ? 'bridge attached and shadowed the real native factory' : 'bridge attached and wrapped the real MMKV class method');
  await action('seedAsync');
  let stores = await command('list');
  const exported = stores.find(store => store.label.includes('devsight-fixture-exported'));
  assert.ok(exported);
  assert.equal((await command('get', { adapter: exported.id, key: 'message' })).value, 'exported native store');
  pass('exported native MMKV is readable');
  const asyncStore = stores.find(store => store.label.startsWith('AsyncStorage'));
  assert.ok(asyncStore);
  assert.equal((await command('get', { adapter: asyncStore.id, key: 'devsight-fixture-async' })).value, 'native AsyncStorage');
  pass('native AsyncStorage is readable without SDK');

  if (mmkvMajor === 4) {
    assert.equal(await action('readBefore'), 'private before connection');
    stores = await command('list');
    assert.equal(stores.some(store => store.label.includes('private-before')), false);
    report.limitations.push('V4 private instance created before attachment remains undiscoverable');
  } else {
    assert.equal(stores.some(store => store.label.includes('private-before')), false);
    assert.equal(await action('readBefore'), 'private before connection');
    stores = await command('list');
    const before = stores.find(store => store.label.includes('devsight-fixture-private-before'));
    assert.ok(before, 'Class hook must capture an existing private instance once the app uses it');
    assert.equal((await command('get', { adapter: before.id, key: 'message' })).value, 'private before connection');
    pass('private native MMKV created before attachment is found once the app uses it again');
    report.limitations.push('V3 private instance created before attachment stays undiscoverable until the app calls one of its methods');
  }

  const created = await action('createAfter');
  assert.equal(created.message, 'private after connection');
  // V4: Nitro HybridObject name. V3: the JSI host function behind getString, not the Jest mock.
  report.nativeObject = mmkvMajor === 4 ? created.nativeName : created.nativeGetString;
  assert.match(report.nativeObject, mmkvMajor === 4 ? /MMKV/ : /native code/);
  stores = await command('list');
  const after = stores.find(store => store.label.includes('devsight-fixture-private-after'));
  assert.ok(after, 'Hook must capture the actual private native instance');
  const list = await command('entries', { adapter: after.id });
  assert.equal(list.total, 9);
  const values = Object.fromEntries(list.entries.map(entry => [entry.key, entry.value]));
  assert.equal(values.message, 'private after connection');
  assert.equal(values.unicode, 'Xin chào 😀');
  assert.equal(values.short, 'abc');
  assert.equal(JSON.parse(values.json).fixture, true);
  pass('private native MMKV created after attachment: list, entries, string, Unicode and JSON');
  const nativeValues = await action('nativeValues');
  for (const [key, value] of Object.entries(nativeValues)) assert.equal(values[key], String(value), key);
  pass('numbers and booleans match typed native reads');
  assert.equal((await command('get', { adapter: after.id, key: 'emoji 😀' })).value, 'astral key');
  pass('key outside the BMP is readable');

  assert.equal(await action('createEncrypted'), 'encrypted native store');
  stores = await command('list');
  const encrypted = stores.find(store => store.label.includes('devsight-fixture-encrypted'));
  assert.ok(encrypted);
  assert.equal((await command('get', { adapter: encrypted.id, key: 'message' })).value, 'encrypted native store');
  pass('encrypted private MMKV is read through its existing native instance');
  assert.equal(await action('changeAfter'), 'changed by the app');
  assert.equal((await command('get', { adapter: after.id, key: 'message' })).value, 'changed by the app');
  pass('refresh observes app-side writes');
  assert.match(await command('set', { adapter: after.id, key: 'message', value: 'forbidden' }, true), /read-only/);
  assert.equal(await action('readAfter'), 'changed by the app');
  pass('Devsight refuses writes without changing fixture data');

  bridge.stop(); bridge = undefined;
  await until(async () => await evaluate('typeof globalThis.__DEVSIGHT_MMKV_TRACKER_V1__') === 'undefined');
  assert.equal(await hooked(), false);
  assert.equal(await action('readAfter'), 'changed by the app');
  pass(`disconnect restores ${mmkvMajor === 4 ? 'native factory' : 'the MMKV class method'} and app storage still works`);
  report.completedAt = new Date().toISOString();
  if (reportFile) writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  bridge?.stop();
  viewer?.terminate();
  await server?.close();
  cdp.close();
}
