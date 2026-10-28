#!/usr/bin/env node
// Presses the example app's buttons through its Dart VM service, for checks that need no hands:
//
//   node dart/example/tool/drive.mjs <vm-service-uri> <action>...   e.g. log.print http.dio.get10k
//   node dart/example/tool/drive.mjs <vm-service-uri> --list
//
// The URI is the one `flutter run` prints: "A Dart VM Service on … is available at: http://127.0.0.1:…/…=/".

const [uri, ...actions] = process.argv.slice(2);
if (!uri || actions.length === 0) {
  console.error('Usage: drive.mjs <vm-service-uri> <action>... | --list');
  process.exit(2);
}

const wsUri = (() => {
  const url = new URL(uri);
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  if (!url.pathname.endsWith('/ws')) url.pathname = `${url.pathname.replace(/\/$/, '')}/ws`;
  return url.href;
})();

const socket = new WebSocket(wsUri);
const pending = new Map();
let nextId = 1;

function call(method, params = {}) {
  const id = String(nextId++);
  socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(`${message.error.message} (${message.error.code})`));
  else waiter.resolve(message.result);
});

socket.addEventListener('error', () => {
  console.error(`Could not connect to ${wsUri}`);
  process.exit(1);
});

socket.addEventListener('open', async () => {
  try {
    const vm = await call('getVM');
    let isolateId;
    for (const ref of vm.isolates) {
      const isolate = await call('getIsolate', { isolateId: ref.id });
      if (isolate.extensionRPCs?.includes('ext.example.run')) isolateId = ref.id;
    }
    if (!isolateId) throw new Error('No isolate registers ext.example.run: is the example app running in debug mode?');
    if (actions[0] === '--list') {
      console.log((await call('ext.example.actions', { isolateId })).actions.join('\n'));
    } else {
      for (const action of actions) console.log(JSON.stringify(await call('ext.example.run', { isolateId, action })));
    }
    socket.close();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
});
