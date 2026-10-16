// Run after building the CLI. Downloads pinned upstream sources to a temporary cache, without
// installing packages or executing package scripts. The native boundary is simulated, not a device.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { trackMMKV } from '../dist/metro-mmkv.js';
import { inspectStorage } from '../dist/metro-storage.js';

const versions = {
  '2.12.2': '6058Aq0p57chPrUutLGe9fYoiDVDNMU2PKV+lLFUJ3GhoHvUrLdsS1PDSCLr00yqzL4WJQ7TTzH+V8cpyrNcfg==',
  '3.3.3': 'GMsfOmNzx0p5+CtrCFRVtpOOMYNJXuksBVARSQrCFaZwjUyHJdQzcN900GGaFFNTxw2fs8s5Xje//RDKj9+PZA==',
  '4.3.2': '49OAyfkg0/TMWiWELZN6VuVQPZPhizwL4DTmp8b7B1md3dB/s3LH3mGfC3T+lp9W0y/rqxZMEnotLFTIbOAenQ==',
};
const cache = process.argv[2] ?? join(tmpdir(), 'capybara-mmkv-compat');
mkdirSync(cache, { recursive: true });
for (const [version, integrity] of Object.entries(versions)) {
  const archive = join(cache, `capybara-mmkv-${version}.tgz`);
  if (!existsSync(archive)) {
    const response = await fetch(`https://registry.npmjs.org/react-native-mmkv/-/react-native-mmkv-${version}.tgz`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Download ${version}: HTTP ${response.status}`);
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  }
  assert.equal(createHash('sha512').update(readFileSync(archive)).digest('base64'), integrity, `Integrity of ${version}`);
  const source = (path) => execFileSync('tar', ['-xzOf', archive, `package/src/${path}`], { encoding: 'utf8' });
  const context = createContext({ setInterval, clearInterval });
  const run = (code) => runInContext(code, context);
  const load = (path, dependencies) => {
    const code = ts.transpileModule(source(path), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const module = { exports: {} };
    run(`(function (require, exports, module) { ${code}\n })`)((id) => {
      if (!(id in dependencies)) throw new Error(`Unexpected upstream import ${id}`);
      return dependencies[id];
    }, module.exports, module);
    return module.exports;
  };
  run(`
    const modules = new Map();
    globalThis.__r = { getModules: () => modules };
    function expose(id, exports, file) { modules.set(id, { isInitialized: true, verboseName: '/node_modules/react-native-mmkv/src/' + file, publicModule: { exports } }); }
    let writes = 0, creations = 0;
    function createNative() {
      creations++;
      const data = { user: 'Ada' };
      return {
        getAllKeys: () => Object.keys(data),
        getString: k => typeof data[k] === 'string' ? data[k] : undefined,
        getNumber: k => typeof data[k] === 'number' ? data[k] : undefined,
        getBoolean: k => typeof data[k] === 'boolean' ? data[k] : undefined,
        set: (k, v) => { writes++; data[k] = v; }
      };
    }
    const nativeData = new WeakMap();
    class NitroMMKV {
      constructor(config) { nativeData.set(this, { id: config.id, api: createNative() }); }
      get id() { return nativeData.get(this).id; }
      getAllKeys() { return nativeData.get(this).api.getAllKeys(); }
      getString(k) { return nativeData.get(this).api.getString(k); }
      getNumber(k) { return nativeData.get(this).api.getNumber(k); }
      getBoolean(k) { return nativeData.get(this).api.getBoolean(k); }
      set(k, v) { return nativeData.get(this).api.set(k, v); }
    }
    // Nitro 0.35.9 cpp/prototype/HybridObjectPrototype.cpp defines non-writable,
    // non-configurable methods and freezes its prototypes in debug builds.
    Object.freeze(NitroMMKV.prototype);
    const factoryPrototype = Object.freeze({
      initializeMMKV() {}, defaultMMKVInstanceId: 'mmkv.default',
      createMMKV(config) { if (this !== factory) throw new Error('Native receiver lost'); return new NitroMMKV(config); }
    });
    const factory = Object.create(factoryPrototype);
    const platformContext = { getBaseDirectory: () => '/app', getAppGroupDirectory: () => undefined };
  `);
  let namespace;
  if (version.startsWith('4.')) {
    const factoryExports = load('getMMKVFactory.ts', {
      'react-native-nitro-modules': { NitroModules: { createHybridObject: name => run(name === 'MMKVFactory' ? 'factory' : 'platformContext') } },
    });
    namespace = load('createMMKV/createMMKV.ts', {
      'react-native': { Platform: { OS: 'ios' } },
      '../addMemoryWarningListener/addMemoryWarningListener': { addMemoryWarningListener() {} },
      '../addContentChangedListener/addContentChangedListener': { addContentChangedListener() {} },
      '../isTest': { isTest: () => false },
      './createMockMMKV': { createMockMMKV() { throw new Error('Unexpected mock'); } },
      '../getMMKVFactory': factoryExports,
    });
    context.factoryExports = factoryExports;
    run('expose(1, factoryExports, "getMMKVFactory.ts")');
  } else {
    namespace = load('MMKV.ts', {
      './createMMKV': { createMMKV: run('createNative') },
      './createMMKV.mock': { createMockMMKV() { throw new Error('Unexpected mock'); } },
      './PlatformChecker': { isJest: () => false, isTest: () => false },
      './MemoryWarningListener': { addMemoryWarningListener() {} },
    });
    context.namespace = namespace;
    run('expose(1, namespace, "MMKV.ts")');
  }
  context.createStorage = namespace.createMMKV ?? (config => new namespace.MMKV(config));
  const track = action => run(`(${trackMMKV.toString()})(${JSON.stringify(action)}, 'matrix')`);
  const inspect = async (method, params = {}) => {
    const state = run(`(${inspectStorage.toString()})(${JSON.stringify(method)}, ${JSON.stringify(params)})`);
    for (let i = 0; !state.done && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(state.done, true);
    assert.equal(state.error, undefined);
    return JSON.parse(JSON.stringify(state.value));
  };
  try {
    run('const readOld = (() => { const hidden = createStorage({ id: "old" }); return () => hidden.getString("user"); })()');
    track('watch');
    assert.equal(run('creations'), 1, 'Attachment must not create a store');
    assert.equal(run('readOld()'), 'Ada');
    assert.equal((await inspect('list')).length, version.startsWith('4.') ? 0 : 1);
    run('const readNew = (() => { const hidden = createStorage({ id: "new" }); hidden.set("user", "Grace"); return () => hidden.getString("user"); })()');
    assert.equal(run('readNew()'), 'Grace');
    const stores = await inspect('list');
    const fresh = stores.find(store => store.label === 'MMKV · new');
    assert.ok(fresh, `Private instance in ${version}`);
    assert.equal((await inspect('entries', { adapter: fresh.id })).entries[0].value, 'Grace');
    assert.equal(run('writes'), 1, 'Inspection must not add writes');
    assert.equal(run('creations'), 2);
    console.log(`MMKV ${version}: real package JS + simulated native boundary passed`);
  } finally {
    track('stop');
  }
  assert.equal(run('globalThis.__CAPYBARA_MMKV_TRACKER_V1__'), undefined);
  assert.equal(run('Object.hasOwn(factory, "createMMKV")'), false);
}
