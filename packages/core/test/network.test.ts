import { afterEach, describe, expect, it, vi } from 'vitest';
import { networkPlugin, serialize, type NetworkPluginOptions, type PluginContext } from '../src/index.js';

type Recorded = { kind: string; payload: any };

function harness(options?: NetworkPluginOptions) {
  const events: Recorded[] = [];
  const ctx: PluginContext = {
    emit: (kind, payload) => events.push({ kind, payload }),
    serialize: (value) => serialize(value),
    console,
  };
  const teardown = networkPlugin(options).setup!(ctx) as () => void;
  const of = (kind: string) => events.filter((e) => e.kind === kind).map((e) => e.payload);
  return { events, of, teardown };
}

class FakeXHR extends EventTarget {
  status = 0;
  statusText = '';
  responseType: XMLHttpRequestResponseType = '';
  responseText = '';
  response: unknown = null;
  private rawHeaders = '';
  open(_method: string, _url: string) {}
  setRequestHeader(_name: string, _value: string) {}
  send(_body?: unknown) {}
  getAllResponseHeaders() {
    return this.rawHeaders;
  }
  respond(status: number, body: string, rawHeaders: string) {
    this.status = status;
    this.statusText = 'OK';
    this.responseText = body;
    this.response = body;
    this.rawHeaders = rawHeaders;
    this.dispatchEvent(new Event('load'));
    this.dispatchEvent(new Event('loadend'));
  }
  fail() {
    this.dispatchEvent(new Event('error'));
    this.dispatchEvent(new Event('loadend'));
  }
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete (globalThis as Record<string, unknown>).XMLHttpRequest;
});

describe('networkPlugin: fetch', () => {
  it('records request and response while the app can still read the body', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 201, headers: { 'content-type': 'application/json' } }),
    );
    const { of, teardown } = harness({ xhr: false });

    const response = await fetch('https://api.test/items', {
      method: 'post',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
      body: '{"name":"a"}',
    });
    expect(await response.json()).toEqual({ ok: true });
    await vi.waitFor(() => expect(of('network.response')).toHaveLength(1));

    const [request] = of('network.request');
    expect(request).toMatchObject({
      initiator: 'fetch',
      method: 'POST',
      url: 'https://api.test/items',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
      body: { kind: 'text', text: '{"name":"a"}', contentType: 'application/json' },
    });
    expect(of('network.response')[0]).toMatchObject({
      id: request.id,
      status: 201,
      headers: { 'content-type': 'application/json' },
      body: { kind: 'text', text: '{"ok":true}', truncated: false },
    });
    teardown();
  });

  it('truncates large bodies and redacts headers', async () => {
    globalThis.fetch = vi.fn(async () => new Response('x'.repeat(50), { headers: { 'content-type': 'text/plain' } }));
    const { of, teardown } = harness({ xhr: false, maxBodySize: 10, redactHeaders: ['authorization'] });
    await fetch('https://api.test/big', { headers: { Authorization: 'secret' } });
    await vi.waitFor(() => expect(of('network.response')).toHaveLength(1));
    expect(of('network.request')[0].headers).toEqual({ Authorization: '[redacted]' });
    expect(of('network.response')[0].body).toMatchObject({ text: 'x'.repeat(10), truncated: true });
    teardown();
  });

  it('records failures and lets the rejection reach the caller', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const { of, teardown } = harness({ xhr: false });
    await expect(fetch('https://down.test/')).rejects.toThrow('Failed to fetch');
    await vi.waitFor(() => expect(of('network.error')).toHaveLength(1));
    expect(of('network.error')[0]).toMatchObject({ message: 'Failed to fetch', aborted: false });
    teardown();
  });

  it('skips ignored URLs and restores fetch on teardown', async () => {
    const stub = vi.fn(async () => new Response('ok'));
    globalThis.fetch = stub;
    const { events, teardown } = harness({ xhr: false, ignoreUrls: ['/health', /\/metrics$/] });
    await fetch('https://api.test/health');
    await fetch('https://api.test/metrics');
    expect(events).toEqual([]);
    teardown();
    expect(globalThis.fetch).toBe(stub);
  });
});

describe('networkPlugin: XMLHttpRequest', () => {
  it('records request headers, body and the response', () => {
    (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
    const { of, teardown } = harness({ fetch: false });
    const xhr = new FakeXHR();
    xhr.open('get', 'https://api.test/users/2');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.send(null);
    xhr.respond(200, '{"id":2}', 'Content-Type: application/json\r\nX-Request-Id: abc\r\n');

    expect(of('network.request')[0]).toMatchObject({
      initiator: 'xhr',
      method: 'GET',
      url: 'https://api.test/users/2',
      headers: { Accept: 'application/json' },
    });
    expect(of('network.response')[0]).toMatchObject({
      status: 200,
      headers: { 'content-type': 'application/json', 'x-request-id': 'abc' },
      body: { kind: 'text', text: '{"id":2}' },
    });
    teardown();
  });

  it('records network errors', () => {
    (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
    const { of, teardown } = harness({ fetch: false });
    const xhr = new FakeXHR();
    xhr.open('POST', 'https://down.test/');
    xhr.send('payload');
    xhr.fail();
    expect(of('network.request')[0].body).toMatchObject({ kind: 'text', text: 'payload' });
    expect(of('network.error')[0]).toMatchObject({ message: 'Network request failed' });
    teardown();
  });

  it('restores the prototype on teardown', () => {
    const { open, send, setRequestHeader } = FakeXHR.prototype;
    (globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;
    const { teardown } = harness({ fetch: false });
    expect(FakeXHR.prototype.open).not.toBe(open);
    teardown();
    expect(FakeXHR.prototype.open).toBe(open);
    expect(FakeXHR.prototype.send).toBe(send);
    expect(FakeXHR.prototype.setRequestHeader).toBe(setRequestHeader);
  });
});
