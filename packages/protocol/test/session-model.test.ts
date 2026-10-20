import { describe, expect, it } from 'vitest';
import { applySessionEvents, emptySessionModel, type CapybaraEvent, type EventPayloads } from '../src/index.js';

let seq = 0;
const event = <K extends keyof EventPayloads>(kind: K, payload: EventPayloads[K]) =>
  ({ seq: ++seq, ts: 1_000 + seq, kind, payload }) as CapybaraEvent;
const apply = (events: CapybaraEvent[], limits = {}) => applySessionEvents(emptySessionModel(), events, limits);

describe('applySessionEvents', () => {
  it('pairs requests with their responses and errors, and ignores a response whose request is gone', () => {
    const { network } = apply([
      event('network.request', { id: 'r1', initiator: 'fetch', method: 'GET', url: 'https://api.test/me', headers: {} }),
      event('network.request', { id: 'r2', initiator: 'xhr', method: 'POST', url: 'https://api.test/cart', headers: {} }),
      event('network.response', { id: 'r1', status: 200, headers: { 'content-type': 'application/json' }, duration: 12 }),
      event('network.error', { id: 'r2', message: 'Failed to fetch', duration: 5, cause: 'cross-origin', credentials: true }),
      event('network.response', { id: 'gone', status: 200, headers: {}, duration: 1 }),
    ]);
    expect(network.map((entry) => [entry.id, entry.state, entry.status, entry.error])).toEqual([
      ['r1', 'done', 200, undefined],
      ['r2', 'failed', undefined, 'Failed to fetch'],
    ]);
    expect(network[1]!.failure).toEqual({ cause: 'cross-origin', credentials: true, aborted: undefined, timeout: undefined });
  });

  it('keeps a streamed response pending with what has arrived, until the last response finishes it', () => {
    const request = event('network.request', { id: 'r1', initiator: 'fetch', method: 'POST', url: 'https://api.test/chat', headers: {} });
    const first = event('network.response', {
      id: 'r1',
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
      body: { kind: 'text', text: '{"t":"Hel"}', size: 11 },
      duration: 40,
      streaming: true,
    });
    const streaming = apply([request, first]).network[0]!;
    expect(streaming).toMatchObject({ state: 'pending', streaming: true, status: 200, responseBody: { text: '{"t":"Hel"}' } });
    const last = event('network.response', { id: 'r1', status: 200, headers: {}, body: { kind: 'text', text: '{"t":"Hel"}\n{"t":"lo"}', size: 23 }, duration: 40 });
    const done = apply([request, first, last]).network[0]!;
    expect(done.state).toBe('done');
    expect('streaming' in done).toBe(false);
    expect(done.responseBody?.text).toBe('{"t":"Hel"}\n{"t":"lo"}');
  });

  it('follows a WebSocket from connect to close, telling a clean close from a dropped one', () => {
    const { network } = apply([
      event('ws.connect', { id: 'w1', url: 'wss://api.test/live' }),
      event('ws.open', { id: 'w1', protocol: 'json', duration: 9 }),
      event('ws.message', { id: 'w1', direction: 'sent', data: { kind: 'text', text: 'hi', size: 2 } }),
      event('ws.message', { id: 'w1', direction: 'received', data: { kind: 'text', text: 'hello', size: 5 } }),
      event('ws.close', { id: 'w1', code: 1000, wasClean: true, duration: 50 }),
      event('ws.connect', { id: 'w2', url: 'wss://api.test/live' }),
      event('ws.open', { id: 'w2', duration: 9 }),
      event('ws.close', { id: 'w2', code: 1006, duration: 80 }),
      event('ws.connect', { id: 'w3', url: 'wss://api.test/live' }),
      event('ws.error', { id: 'w3', message: 'Connection refused' }),
      event('ws.close', { id: 'w3', code: 1006, duration: 3 }),
    ]);
    const [clean, dropped, refused] = network;
    expect(clean).toMatchObject({ state: 'done', status: 101, duration: 50, socket: { protocol: 'json', sent: 1, received: 1, bytes: 7, closeCode: 1000 } });
    expect(dropped).toMatchObject({ state: 'failed', error: 'Closed with code 1006' });
    expect(refused).toMatchObject({ state: 'failed', error: 'Connection refused' });
  });

  it('keeps the newest within the limits, counting the socket messages it drops', () => {
    const connect = event('ws.connect', { id: 'w1', url: 'wss://api.test/live' });
    const messages = Array.from({ length: 5 }, () =>
      event('ws.message', { id: 'w1', direction: 'received', data: { kind: 'text', text: 'x', size: 1 } }),
    );
    const logs = Array.from({ length: 4 }, (_, i) => event('log', { level: 'log', source: 'console', args: [`#${i}`] }));
    const model = apply([connect, ...messages, ...logs], {
      socketMessages: 3,
      logs: 2,
    });
    expect(model.network[0]!.socket).toMatchObject({ received: 5, dropped: 2 });
    expect(model.network[0]!.socket!.messages.map((message) => message.seq)).toEqual(messages.slice(2).map((message) => message.seq));
    expect(model.logs.map((entry) => entry.args[0])).toEqual(['#2', '#3']);
  });

  it('skips events it has applied, and leaves the model it was given as it was', () => {
    const first = apply([
      event('log', { level: 'info', source: 'console', args: ['one'] }),
      event('network.request', { id: 'r1', initiator: 'fetch', method: 'GET', url: 'https://api.test/', headers: {} }),
      event('storage.change', { adapter: 'localStorage', op: 'set', key: 'cart' }),
    ]);
    const replayed = event('log', { level: 'info', source: 'console', args: ['two'] });
    const next = applySessionEvents(first, [
      { ...replayed, seq: first.lastSeq },
      replayed,
      event('network.response', { id: 'r1', status: 204, headers: {}, duration: 3 }),
      event('storage.change', { adapter: 'localStorage', op: 'remove', key: 'cart' }),
      event('state.store', { store: { id: 'redux:1', library: 'redux', label: 'shop', via: 'shim', actions: true } }),
    ]);
    expect(next.logs.map((entry) => entry.args[0])).toEqual(['one', 'two']);
    expect(next.network[0]!.state).toBe('done');
    expect(next.storageVersions).toEqual({ localStorage: 2 });
    expect(Object.keys(next.state.stores)).toEqual(['redux:1']);
    // The UI keeps the old model for the render in progress.
    expect(first.logs).toHaveLength(1);
    expect(first.network[0]!.state).toBe('pending');
    expect(first.storageVersions).toEqual({ localStorage: 1 });
    expect(first.state.stores).toEqual({});
  });
});
