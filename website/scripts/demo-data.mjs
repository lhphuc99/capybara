// Made-up apps and data for the website's screenshots. Nothing here comes from a real app.

const START = Date.parse('2026-10-16T09:41:00Z');

const webApp = {
  id: 'demo-web',
  appName: 'Yuzu Market',
  platform: 'web',
  sdk: { name: '@capybara-devtools/web', version: '0.1.0' },
  startedAt: START,
  url: 'http://localhost:5173/',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};

const nativeApp = {
  id: 'demo-native',
  appName: 'Onsen Notes',
  platform: 'ios',
  sdk: { name: 'metro', version: '0.1.0' },
  startedAt: START,
  device: { model: 'iPhone 17', osVersion: '26.0', isEmulator: true },
  runtime: 'Hermes · RN 0.86.3',
};

function timeline() {
  const events = [];
  let ts = START;
  return {
    events,
    add(afterMs, kind, payload) {
      ts += afterMs;
      events.push({ seq: events.length + 1, ts, kind, payload });
    },
  };
}

const json = (value) => {
  const text = JSON.stringify(value);
  return { kind: 'text', text, size: Buffer.byteLength(text), contentType: 'application/json' };
};

function webEvents() {
  const { events, add } = timeline();
  const site = 'http://localhost:5173';
  const request = (id, method, url, extra = {}) =>
    add(40, 'network.request', { id, initiator: 'fetch', method, url, headers: { accept: 'application/json' }, ...extra });

  add(0, 'log', { level: 'info', source: 'console', args: ['Yuzu Market 2.3.0 · development build'] });
  request('r1', 'GET', `${site}/api/products?category=tea`);
  add(84, 'network.response', {
    id: 'r1',
    status: 200,
    statusText: 'OK',
    duration: 84,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-request-id': 'req_7f3a9c' },
    body: json({
      items: [
        { id: 'tea-yuzu-01', name: 'Yuzu green tea', price: 12.5, currency: 'USD', stock: 42, tags: ['citrus', 'green'] },
        { id: 'tea-hojicha-02', name: 'Roasted hojicha', price: 9, currency: 'USD', stock: 0, tags: ['roasted'] },
        { id: 'snack-mochi-03', name: 'Yuzu mochi, 6 pieces', price: 7.25, currency: 'USD', stock: 18, tags: ['sweet'] },
      ],
      page: 1,
      total: 3,
    }),
  });
  const ok = (id, duration, value, status = 200, statusText = 'OK') =>
    add(duration, 'network.response', { id, status, statusText, duration, headers: { 'content-type': 'application/json' }, body: json(value) });
  const image = (id, file, size, duration) => {
    add(15, 'network.request', { id, initiator: 'image', method: 'GET', url: `https://images.example.com/products/${file}`, headers: {} });
    add(duration, 'network.response', {
      id,
      status: 200,
      statusText: 'OK',
      duration,
      headers: { 'content-type': 'image/webp', 'content-length': String(size) },
      body: { kind: 'binary', size, contentType: 'image/webp', summary: 'WebP image' },
    });
  };

  request('r2', 'GET', `${site}/api/me`);
  ok('r2', 31, { id: 'u_1042', name: 'Ada', plan: 'pro', cart: { items: 2 } });
  request('r2b', 'GET', `${site}/api/categories`);
  ok('r2b', 22, [{ id: 'tea', name: 'Tea' }, { id: 'snacks', name: 'Snacks' }, { id: 'bath', name: 'Bath' }]);
  image('r3', 'yuzu-tea.webp', 48213, 122);
  image('r3b', 'hojicha.webp', 39876, 97);
  image('r3c', 'yuzu-mochi.webp', 52110, 131);
  add(30, 'ws.connect', { id: 'w1', url: 'ws://localhost:5173/api/live' });
  add(14, 'ws.open', { id: 'w1', duration: 14 });
  add(5, 'ws.message', { id: 'w1', direction: 'sent', data: { kind: 'text', text: '{"type":"subscribe","channel":"prices"}' } });
  add(210, 'ws.message', { id: 'w1', direction: 'received', data: { kind: 'text', text: '{"type":"price","sku":"tea-yuzu-01","price":11.9}' } });
  add(40, 'network.request', {
    id: 'r4',
    initiator: 'fetch',
    method: 'POST',
    url: `${site}/api/cart`,
    headers: { 'content-type': 'application/json' },
    body: json({ sku: 'tea-yuzu-01', qty: 1 }),
  });
  ok('r4', 58, { cartId: 'c_88', items: 3 }, 201, 'Created');
  request('r4b', 'GET', `${site}/api/shipping/rates?country=JP`);
  ok('r4b', 64, { currency: 'USD', rates: [{ id: 'standard', price: 6 }, { id: 'express', price: 14 }] });
  add(10, 'network.request', {
    id: 'r4c',
    initiator: 'fetch',
    method: 'POST',
    url: `${site}/api/events`,
    headers: { 'content-type': 'application/json' },
    body: json({ name: 'add_to_cart', sku: 'tea-yuzu-01' }),
  });
  add(18, 'network.response', { id: 'r4c', status: 204, statusText: 'No Content', duration: 18, headers: {} });
  request('r5', 'GET', 'http://localhost:4000/api/rewards?user=u_1042');
  add(6, 'network.error', { id: 'r5', message: 'Failed to fetch', duration: 6, cause: 'cross-origin' });
  add(3, 'log', {
    level: 'error',
    source: 'console',
    args: [
      'Could not load rewards',
      { $t: 'error', name: 'TypeError', message: 'Failed to fetch', stack: 'TypeError: Failed to fetch\n    at loadRewards (src/api/rewards.ts:12:9)\n    at RewardsBadge (src/components/RewardsBadge.tsx:8:5)' },
    ],
  });
  request('r6', 'GET', `${site}/api/recommendations`);
  add(1520, 'network.response', {
    id: 'r6',
    status: 500,
    statusText: 'Internal Server Error',
    duration: 1520,
    headers: { 'content-type': 'application/json' },
    body: json({ error: 'Upstream timeout' }),
  });
  add(4, 'log', { level: 'warn', source: 'console', args: ['Recommendations unavailable, showing best sellers'] });
  request('r7', 'GET', `${site}/api/products/tea-yuzu-01/reviews`);
  ok('r7', 47, { rating: 4.8, count: 126 });
  request('r8', 'GET', `${site}/api/search?q=yuzu`);
  ok('r8', 73, { query: 'yuzu', results: 9 });
  add(12, 'ws.message', { id: 'w1', direction: 'received', data: { kind: 'text', text: '{"type":"price","sku":"snack-mochi-03","price":6.9}' } });
  add(30, 'network.request', {
    id: 'r9',
    initiator: 'xhr',
    method: 'PUT',
    url: `${site}/api/cart/items/tea-yuzu-01`,
    headers: { 'content-type': 'application/json' },
    body: json({ qty: 2 }),
  });
  ok('r9', 52, { cartId: 'c_88', items: 4 });
  request('r10', 'GET', `${site}/api/products/snack-mochi-03`);
  ok('r10', 29, { id: 'snack-mochi-03', name: 'Yuzu mochi, 6 pieces', price: 7.25, stock: 18 });
  return events;
}

function nativeEvents() {
  const { events, add } = timeline();
  const log = (afterMs, level, ...args) => add(afterMs, 'log', { level, source: 'console', args });
  log(0, 'info', 'Running "OnsenNotes" with {"rootTag":1,"initialProps":{}}');
  log(180, 'log', 'Notes loaded', {
    count: 12,
    lastSync: { $t: 'date', v: '2026-10-16T09:40:12.000Z' },
    folders: ['Inbox', 'Trips', 'Recipes'],
  });
  log(40, 'debug', 'Sync queue', {
    $t: 'map',
    size: 2,
    entries: [
      ['note-42', { op: 'update', title: 'Hakone weekend' }],
      ['note-43', { op: 'create', title: 'Yuzu bath' }],
    ],
  });
  add(30, 'network.request', { id: 'n1', initiator: 'other', method: 'GET', url: 'https://api.example.com/v1/notes?since=2026-10-15', headers: { accept: 'application/json' } });
  add(212, 'network.response', {
    id: 'n1',
    status: 200,
    statusText: 'OK',
    duration: 212,
    headers: { 'content-type': 'application/json' },
    body: json({ notes: [{ id: 'note-42', title: 'Hakone weekend' }], next: null }),
  });
  log(25, 'debug', '[sync] uploading 2 changes');
  log(70, 'log', 'Navigated to', { screen: 'NoteDetail', params: { id: 'note-42' } });
  log(90, 'warn', 'VirtualizedList: You have a large list that is slow to update', { dt: 812, prevDt: 655, contentLength: 18400 });
  log(120, 'error', {
    $t: 'error',
    name: 'TypeError',
    message: "Cannot read property 'title' of undefined",
    stack:
      "TypeError: Cannot read property 'title' of undefined\n    at NoteCard (src/components/NoteCard.tsx:18:22)\n    at NotesList (src/screens/NotesList.tsx:41:9)\n    at App (src/App.tsx:27:7)",
  });
  log(400, 'log', 'Draft saved', { id: 'note-44', words: 128, folder: 'Trips' });
  log(60, 'info', 'Sync finished in 214 ms');
  log(35, 'debug', 'Image cache', { hits: 46, misses: 4, sizeMB: 12.6 });
  log(120, 'log', 'Search', { query: 'yuzu', results: 3 });
  return events;
}

const settings = { theme: 'system', fontSize: 16, sync: { enabled: true, wifiOnly: false }, language: 'en' };

const storage = {
  adapters: [
    { id: 'asyncStorage', label: 'AsyncStorage', readOnly: false, canClear: true },
    { id: 'mmkv', label: 'MMKV', readOnly: false, canClear: true },
  ],
  values: {
    asyncStorage: {
      '@onboarding/done': 'true',
      'recent-searches': JSON.stringify(['ryokan', 'hot spring', 'yuzu bath']),
      settings: JSON.stringify(settings),
      'draft:note-44': 'Packing list: towel, yukata, sandals, yuzu soap',
    },
    mmkv: {
      'user.session': JSON.stringify({ userId: 'u_1042', name: 'Ada', token: 'demo-token-not-real', expiresAt: '2026-11-15T09:41:00Z' }),
      'notes.lastSync': '2026-10-16T09:40:12.000Z',
      'feature.flags': JSON.stringify({ newEditor: true, sharedFolders: false }),
      'app.launchCount': '27',
    },
  },
};

/** Answers the UI's storage commands the way an app with the SDK does. */
function answerStorage(method, params) {
  const entry = (key, value) => ({ key, value, size: Buffer.byteLength(value), truncated: false });
  const values = storage.values[params?.adapter] ?? {};
  switch (method) {
    case 'list':
      return storage.adapters;
    case 'entries':
      return { entries: Object.entries(values).map(([key, value]) => entry(key, value)), total: Object.keys(values).length };
    case 'get':
      return params.key in values ? entry(params.key, values[params.key]) : null;
    default:
      throw new Error('The demo app is read-only');
  }
}

const stateStores = [
  { id: 'redux:1', library: 'redux', label: 'shop', via: 'shim', actions: true },
  { id: 'zustand:1', library: 'zustand', label: 'ui', via: 'shim', actions: true },
  {
    id: 'tanstack-query:1',
    library: 'tanstack-query',
    label: 'QueryClient',
    via: 'client',
    actions: false,
    ops: ['refetch', 'invalidate', 'reset', 'cancel', 'remove'],
  },
  { id: 'swr:1', library: 'swr', label: 'default', via: 'cache', actions: false, ops: ['revalidate', 'clear', 'reset'] },
  { id: 'context:1', library: 'context', label: 'AuthProvider', via: 'fiber', actions: false },
];

const shopState = {
  user: { status: 'signedIn', profile: { id: 'u_1042', name: 'Ada', plan: 'pro' } },
  products: { filter: 'tea', sort: 'price' },
  cart: {
    items: [
      { id: 'tea-yuzu-01', qty: 1, price: 12.5 },
      { id: 'snack-mochi-03', qty: 2, price: 7.25 },
    ],
    total: 27,
    updatedAt: '2026-10-16T09:41:14.280Z',
  },
  checkout: { step: 'cart' },
};

const set = (path, prev, value) => ({ op: 'set', path, prev, value });
const add = (path, value) => ({ op: 'add', path, value });

// [ms after the previous change, change]
const shopChanges = [
  [9_000, { cause: 'init', action: { type: '@@INIT' }, ops: [] }],
  [520, { action: { type: 'user/login/pending' }, ops: [set(['user', 'status'], 'idle', 'pending')] }],
  [
    570,
    {
      action: { type: 'user/login/fulfilled', payload: { payload: { id: 'u_1042', name: 'Ada' } } },
      ops: [set(['user', 'status'], 'pending', 'signedIn'), add(['user', 'profile'], { id: 'u_1042', name: 'Ada', plan: 'pro' })],
    },
  ],
  [640, { action: { type: 'products/setFilter', payload: { payload: 'tea' } }, ops: [set(['products', 'filter'], 'all', 'tea')] }],
  [
    510,
    {
      action: { type: 'cart/addItem', payload: { payload: { id: 'tea-yuzu-01', qty: 1 } } },
      ops: [add(['cart', 'items', 0], { id: 'tea-yuzu-01', qty: 1, price: 12.5 }), set(['cart', 'total'], 0, 12.5)],
    },
  ],
  [2_520, { action: { type: 'products/setSort', payload: { payload: 'price' } }, ops: [set(['products', 'sort'], 'popular', 'price')] }],
  [
    520,
    {
      action: { type: 'cart/addItem', payload: { payload: { id: 'snack-mochi-03', qty: 2 } } },
      ops: [
        add(['cart', 'items', 1], { id: 'snack-mochi-03', qty: 2, price: 7.25 }),
        set(['cart', 'total'], 12.5, 27),
        set(['cart', 'updatedAt'], '2026-10-16T09:41:11.240Z', '2026-10-16T09:41:14.280Z'),
      ],
    },
  ],
  [590, { action: { type: 'checkout/start' }, ops: [set(['checkout', 'step'], 'idle', 'cart')] }],
];

const query = (key, extra) => ({ key, label: key, kind: 'query', status: 'success', fetching: false, active: true, ...extra });
const queries = [
  query('["products","tea"]', { stale: false, observers: 2, updatedAt: START + 12_010, preview: '{items, page, total}' }),
  query('["user",1042]', { stale: true, observers: 1, updatedAt: START + 10_312, preview: '{id, name, plan}' }),
  query('["user",1]', { status: 'error', observers: 1, updatedAt: START + 15_774, error: 'Request failed with status code 404' }),
];

function stateEvents() {
  const { events, add: emit } = timeline();
  emit(0, 'log', { level: 'info', source: 'console', args: ['Yuzu Market 2.3.0 · development build'] });
  for (const store of stateStores) emit(0, 'state.store', { store });
  shopChanges.forEach(([afterMs, change], index) => emit(afterMs, 'state.change', { store: 'redux:1', rev: index + 1, cause: 'action', ...change }));
  emit(800, 'state.entries', { store: 'tanstack-query:1', upserts: queries, removed: [], reset: true });
  return events;
}

/** Answers the UI's state commands the way an app with the SDK does. */
function answerState(method, params) {
  switch (method) {
    case 'stores':
      return stateStores;
    case 'get': {
      let value = params.store === 'redux:1' ? shopState : {};
      for (const key of params.path ?? []) value = value?.[key];
      return { rev: shopChanges.length, pending: false, value: value ?? null, truncated: false };
    }
    case 'entries':
      return params.store === 'tanstack-query:1' ? { entries: queries, total: queries.length } : { entries: [], total: 0 };
    case 'entry': {
      const summary = queries.find((entry) => entry.key === params.key);
      return summary ? { summary, data: null, truncated: false } : null;
    }
    default:
      throw new Error('The demo app is read-only');
  }
}

export const apps = {
  web: { session: webApp, events: webEvents() },
  native: { session: nativeApp, events: nativeEvents() },
  nativeWithSdk: {
    session: { ...nativeApp, id: 'demo-native-sdk', sdk: { name: '@capybara-devtools/react-native', version: '0.1.0' } },
    events: nativeEvents(),
    answer: answerStorage,
  },
  webWithState: {
    session: {
      ...webApp,
      id: 'demo-web-state',
      sdk: { name: '@capybara-devtools/web', version: '0.3.0' },
      plugins: ['console', 'errors', 'network', 'websocket', 'storage', 'state'],
    },
    events: stateEvents(),
    answer: (method, params, plugin) => (plugin === 'state' ? answerState(method, params) : null),
  },
};
