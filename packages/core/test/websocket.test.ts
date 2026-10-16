import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, hookWebSockets, networkPlugin, type NetworkPluginOptions, type PluginContext } from '../src/index.js';

type Recorded = { kind: string; payload: any };

/** Browser-like: events are dispatched natively, never through a JS dispatchEvent. */
class BrowserSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: BrowserSocket[] = [];
  readyState = 0;
  protocol = '';
  extensions = '';
  url: string;
  sent: unknown[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string | URL, readonly protocols?: string | string[]) {
    this.url = String(url);
    BrowserSocket.instances.push(this);
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  send(data: unknown) {
    if (this.readyState !== 1) throw new Error('InvalidStateError');
    this.sent.push(data);
  }
  close() {}
  fire(type: string, init: Record<string, unknown> = {}) {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    const event = { type, ...init };
    (this as unknown as Record<string, ((event: unknown) => void) | null>)[`on${type}`]?.(event);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function harness(options: NetworkPluginOptions = {}) {
  const events: Recorded[] = [];
  const ctx: PluginContext = {
    emit: (kind, payload) => events.push({ kind, payload }),
    serialize: (value) => value as never,
    console: { log() {}, warn() {}, error() {} },
  };
  const teardown = networkPlugin({ fetch: false, xhr: false, ...options }).setup!(ctx) as () => void;
  return { events, teardown, kinds: () => events.map((e) => e.kind) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  BrowserSocket.instances = [];
});

describe('WebSocket capture', () => {
  it('records connect, open, messages both ways and close for sockets created after setup', () => {
    vi.stubGlobal('WebSocket', BrowserSocket);
    const { events, teardown } = harness();
    const WebSocketCtor = globalThis.WebSocket as unknown as typeof BrowserSocket;
    const ws = new WebSocketCtor('wss://chat.example.test/live', ['v1']);
    expect(ws).toBeInstanceOf(BrowserSocket);
    expect(ws).toBeInstanceOf(WebSocketCtor);
    expect(WebSocketCtor.OPEN).toBe(1);

    expect(() => ws.send('too early')).toThrow('InvalidStateError');
    ws.fire('open');
    ws.send('hello');
    ws.fire('message', { data: '{"a":1}' });
    ws.fire('message', { data: new ArrayBuffer(8) });
    ws.fire('close', { code: 1000, reason: 'bye', wasClean: true });

    const id = events[0]!.payload.id;
    expect(events.map((e) => [e.kind, e.payload.direction ?? '', e.payload.data?.text ?? e.payload.data?.size ?? ''])).toEqual([
      ['ws.connect', '', ''],
      ['ws.open', '', ''],
      ['ws.message', 'sent', 'hello'],
      ['ws.message', 'received', '{"a":1}'],
      ['ws.message', 'received', 8],
      ['ws.close', '', ''],
    ]);
    expect(events[0]!.payload).toEqual({ id, url: 'wss://chat.example.test/live', protocols: ['v1'], existing: undefined });
    expect(events[4]!.payload.data).toMatchObject({ kind: 'binary', size: 8, summary: 'ArrayBuffer' });
    expect(events[5]!.payload).toMatchObject({ id, code: 1000, reason: 'bye', wasClean: true });
    expect(events.every((e) => e.payload.id === id)).toBe(true);
    expect(ws.sent).toEqual(['hello']);

    teardown();
    expect(globalThis.WebSocket).toBe(BrowserSocket);
  });

  it('cuts long messages and leaves ignored URLs and dev tool sockets alone', () => {
    vi.stubGlobal('WebSocket', BrowserSocket);
    const { events, teardown } = harness({ maxMessageSize: 5, ignoreUrls: ['/hmr', /:8097\//] });
    const WebSocketCtor = globalThis.WebSocket as unknown as typeof BrowserSocket;
    new WebSocketCtor('ws://localhost:3000/hmr').fire('open');
    new WebSocketCtor('ws://localhost:8097/').fire('open');
    new WebSocketCtor('ws://localhost:5173/?token=abc', 'vite-hmr').fire('open');
    expect(events).toEqual([]);

    const ws = new WebSocketCtor('ws://localhost:3000/feed');
    ws.fire('message', { data: 'hello world' });
    expect(events[1]!.payload.data).toEqual({ kind: 'text', text: 'hello', size: 11, truncated: true });
    teardown();
  });

  it("never records the SDK's own connection", async () => {
    vi.stubGlobal('WebSocket', BrowserSocket);
    const client = createClient({
      url: 'ws://devsight.test/client',
      session: { appName: 'Test', platform: 'web', sdk: { name: 'test', version: '0' } },
      plugins: [networkPlugin({ fetch: false, xhr: false })],
      flushInterval: 1,
    });
    const transport = BrowserSocket.instances[0]!;
    expect(transport.url).toBe('ws://devsight.test/client');
    transport.fire('open');
    transport.fire('message', { data: JSON.stringify({ t: 'welcome', lastSeq: 0 }) });

    const app = new (globalThis.WebSocket as unknown as typeof BrowserSocket)('wss://app.example.test/socket');
    app.fire('open');
    await vi.waitFor(() => expect(transport.sent.some((data) => String(data).includes('ws.open'))).toBe(true));
    const kinds = transport.sent.flatMap((data) => {
      const message = JSON.parse(String(data));
      return message.t === 'events' ? message.events.map((e: Recorded) => `${e.kind} ${e.payload.url ?? ''}`.trim()) : [];
    });
    expect(kinds).toEqual(['ws.connect wss://app.example.test/socket', 'ws.open']);
    client.stop();
    expect(globalThis.WebSocket).toBe(BrowserSocket);
  });

  it('on React Native also records earlier sockets and ones made through a saved constructor', () => {
    // React Native dispatches socket events from JS, through dispatchEvent on the socket.
    class EventTargetShim {
      private listeners = new Map<string, Set<(event: unknown) => void>>();
      addEventListener(type: string, listener: (event: unknown) => void) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type)!.add(listener);
      }
      dispatchEvent(event: { type: string }) {
        for (const listener of this.listeners.get(event.type) ?? []) listener(event);
        return true;
      }
    }
    class NativeSocket extends EventTargetShim {
      readyState = 0;
      protocol = '';
      sent: unknown[] = [];
      constructor(readonly url: string, readonly protocols?: string | string[]) {
        super();
      }
      send(data: unknown) {
        this.sent.push(data);
      }
      deliver(type: string, init: Record<string, unknown> = {}) {
        if (type === 'open') {
          this.readyState = 1;
          this.protocol = 'chat';
        }
        this.dispatchEvent({ type, ...init });
      }
    }
    vi.stubGlobal('navigator', { product: 'ReactNative' });
    vi.stubGlobal('WebSocket', NativeSocket);
    const early = new NativeSocket('ws://early.test');
    early.readyState = 1;
    const Saved = globalThis.WebSocket as unknown as typeof NativeSocket;

    // The Metro bridge runs the hook from its source text, so it must not depend on module scope.
    const rebuilt = new Function(`return (${hookWebSockets.toString()})`)() as typeof hookWebSockets;
    const events: Recorded[] = [];
    const unhook = rebuilt((kind, payload) => events.push({ kind, payload }), { ignoreUrls: [], ignoreProtocols: [], maxMessage: 100 });

    early.deliver('message', { data: 'hi' });
    const viaSaved = new Saved('ws://saved.test');
    viaSaved.deliver('open');
    viaSaved.send('x');
    const viaGlobal = new (globalThis.WebSocket as unknown as typeof NativeSocket)('ws://global.test', 'chat');
    viaGlobal.deliver('open');
    viaGlobal.deliver('close', { code: 1006, reason: 'Expected HTTP 101 response but was 401' });
    const internal = new Saved('ws://devsight.test/client');
    (internal as unknown as Record<string, unknown>).__DEVSIGHT_INTERNAL__ = true;
    internal.deliver('open');
    internal.send('event batch');

    const summary = events.map((e) => [e.kind, e.payload.url ?? e.payload.direction ?? e.payload.code ?? '', e.payload.existing ?? '']);
    expect(summary).toEqual([
      ['ws.connect', 'ws://early.test', true],
      ['ws.open', '', ''],
      ['ws.message', 'received', ''],
      ['ws.connect', 'ws://saved.test', true],
      ['ws.open', '', ''],
      ['ws.message', 'sent', ''],
      ['ws.connect', 'ws://global.test', ''],
      ['ws.open', '', ''],
      ['ws.close', 1006, ''],
    ]);
    expect(events[6]!.payload.protocols).toEqual(['chat']);
    expect(events[8]!.payload.reason).toBe('Expected HTTP 101 response but was 401');

    unhook();
    expect(globalThis.WebSocket).toBe(NativeSocket);
    expect(Object.prototype.hasOwnProperty.call(NativeSocket.prototype, 'dispatchEvent')).toBe(false);
    expect(NativeSocket.prototype.send.toString()).toContain('this.sent.push');
  });
});
