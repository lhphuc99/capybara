import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consolePlugin, createClient, getActiveClient, type ClientOptions, type Plugin } from '../src/index.js';
import type { SocketLike } from '../src/transport.js';

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: any[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({});
  }
  events() {
    return this.sent.filter((m) => m.t === 'events').flatMap((m) => m.events);
  }
}

function setup(plugins: Plugin[] = [], extra: Partial<ClientOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const client = createClient({
    url: 'ws://test/client',
    session: { appName: 'Test', platform: 'web', sdk: { name: 'test', version: '0' } },
    plugins,
    flushInterval: 0,
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    ...extra,
  });
  return { client, sockets };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  getActiveClient()?.stop();
  vi.useRealTimers();
});

describe('createClient', () => {
  it('says hello on open and sends events only after the welcome', () => {
    const { client, sockets } = setup();
    const socket = sockets[0]!;
    socket.open();
    expect(socket.sent[0]).toMatchObject({ t: 'hello', protocol: 1, session: { appName: 'Test', id: client.session.id } });

    client.log('info', 'hello', { a: 1 });
    vi.runOnlyPendingTimers();
    expect(socket.events()).toEqual([]);

    socket.receive({ t: 'welcome', lastSeq: 0 });
    expect(socket.events()).toMatchObject([
      { seq: 1, kind: 'log', payload: { level: 'info', source: 'api', args: ['hello', { a: 1 }] } },
    ]);
    expect(client.connected).toBe(true);
  });

  it('names its plugins in the hello', () => {
    const { sockets } = setup([{ name: 'network' }, { name: 'state' }]);
    sockets[0]!.open();
    expect(sockets[0]!.sent[0]).toMatchObject({ t: 'hello', session: { plugins: ['network', 'state'] } });
  });

  it('after a reconnect resends only what the server is missing', () => {
    const { client, sockets } = setup();
    sockets[0]!.open();
    sockets[0]!.receive({ t: 'welcome', lastSeq: 0 });
    client.log('log', 'one');
    client.log('log', 'two');
    client.log('log', 'three');
    vi.runOnlyPendingTimers();
    expect(sockets[0]!.events().map((e: any) => e.seq)).toEqual([1, 2, 3]);

    sockets[0]!.drop();
    expect(client.connected).toBe(false);
    vi.advanceTimersByTime(1_000);
    const second = sockets[1]!;
    second.open();
    second.receive({ t: 'welcome', lastSeq: 2 });
    expect(second.events().map((e: any) => e.seq)).toEqual([3]);
  });

  it('drops the oldest events when the buffer is full', () => {
    const { client, sockets } = setup([], { maxBufferEvents: 2 });
    client.log('log', 'a');
    client.log('log', 'b');
    client.log('log', 'c');
    sockets[0]!.open();
    sockets[0]!.receive({ t: 'welcome', lastSeq: 0 });
    expect(sockets[0]!.events().map((e: any) => e.payload.args[0])).toEqual(['b', 'c']);
  });

  it('runs plugin commands and reports results and errors', async () => {
    const plugin: Plugin = {
      name: 'demo',
      commands: {
        echo: (params) => ({ got: params }),
        fail: () => {
          throw new Error('nope');
        },
      },
    };
    const { sockets } = setup([plugin]);
    const socket = sockets[0]!;
    socket.open();
    socket.receive({ t: 'welcome', lastSeq: 0 });
    socket.receive({ t: 'command', id: 'c1', plugin: 'demo', method: 'echo', params: 42 });
    socket.receive({ t: 'command', id: 'c2', plugin: 'demo', method: 'fail' });
    socket.receive({ t: 'command', id: 'c3', plugin: 'demo', method: 'missing' });
    await settle();
    // Synchronous failures reply before awaited successes, so compare in id order.
    const results = socket.sent.filter((m) => m.t === 'result').sort((a, b) => a.id.localeCompare(b.id));
    expect(results).toEqual([
      { t: 'result', id: 'c1', ok: true, result: { got: 42 } },
      { t: 'result', id: 'c2', ok: false, error: 'nope' },
      { t: 'result', id: 'c3', ok: false, error: 'Unknown command demo.missing' },
    ]);
  });

  it('records console calls, still calls the original, and restores it on stop', () => {
    const calls: unknown[][] = [];
    const realWarn = console.warn;
    const stub = (...args: unknown[]) => calls.push(args);
    console.warn = stub;
    try {
      const { client, sockets } = setup([consolePlugin()]);
      sockets[0]!.open();
      sockets[0]!.receive({ t: 'welcome', lastSeq: 0 });
      console.warn('careful', { n: 1 });
      vi.runOnlyPendingTimers();
      expect(calls).toEqual([['careful', { n: 1 }]]);
      expect(sockets[0]!.events()).toMatchObject([
        { kind: 'log', payload: { level: 'warn', source: 'console', args: ['careful', { n: 1 }] } },
      ]);
      client.stop();
      expect(console.warn).toBe(stub);
    } finally {
      console.warn = realWarn;
    }
  });

  it('prints but does not record console calls that match an ignore pattern', () => {
    const calls: unknown[][] = [];
    const realInfo = console.info;
    console.info = (...args: unknown[]) => calls.push(args);
    try {
      const { client, sockets } = setup([consolePlugin({ ignore: [/React DevTools/] })]);
      sockets[0]!.open();
      sockets[0]!.receive({ t: 'welcome', lastSeq: 0 });
      console.info('%cDownload the React DevTools for a better development experience', 'font-weight:bold');
      console.info('kept', 'React DevTools');
      vi.runOnlyPendingTimers();
      expect(calls).toHaveLength(2);
      expect(sockets[0]!.events()).toMatchObject([{ kind: 'log', payload: { level: 'info', args: ['kept', 'React DevTools'] } }]);
      client.stop();
    } finally {
      console.info = realInfo;
    }
  });

  it('replaces an earlier client instead of patching twice', () => {
    const realLog = console.log;
    const stub = () => {};
    console.log = stub;
    try {
      setup([consolePlugin()]);
      const second = setup([consolePlugin()]).client;
      expect(getActiveClient()).toBe(second);
      second.stop();
      // Only unwinds to the stub if the first client removed its patch when it was replaced.
      expect(console.log).toBe(stub);
    } finally {
      console.log = realLog;
    }
  });
});
