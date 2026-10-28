import type { SerializedValue, SessionInfo } from '@capybara-devtools/protocol';
import { describe, expect, it } from 'vitest';
import { decodeSocketIo, describeSession, isFetchOrXhr, logEntryText, platformLabel, toCurl, valueText } from '../src/format';
import type { LogEntry, NetworkEntry } from '../src/store';

describe('toCurl', () => {
  const request = (fields: Partial<NetworkEntry>): NetworkEntry => ({
    id: 'r1',
    seq: 1,
    ts: 0,
    initiator: 'fetch',
    method: 'GET',
    url: 'https://api.test/items',
    requestHeaders: {},
    state: 'done',
    ...fields,
  });

  it('copies the method, headers and text body', () => {
    const curl = toCurl(
      request({
        method: 'POST',
        requestHeaders: { 'Content-Type': 'application/json' },
        requestBody: { kind: 'text', text: `{"name":"O'Neil"}` },
      }),
    );
    expect(curl).toEqual({
      command: `curl 'https://api.test/items' \\\n  -X POST \\\n  -H 'Content-Type: application/json' \\\n  --data-raw '{"name":"O'\\''Neil"}'`,
      note: undefined,
    });
  });

  it('asks for the headers of a HEAD request, since curl waits for a body with -X HEAD', () => {
    expect(toCurl(request({ method: 'HEAD' })).command).toBe(`curl 'https://api.test/items' \\\n  --head`);
  });

  it('sends form fields as they were, files by name from the current folder', () => {
    const curl = toCurl(
      request({
        method: 'POST',
        requestHeaders: { 'content-type': 'multipart/form-data', 'X-Token': 'abc' },
        requestBody: {
          kind: 'form',
          text: 'title=Trip\nnote=@home\nline one\navatar=[file photo "1".jpg, image/jpeg, 1200 B]\nlog=[file file:///data/cache/app.log]',
        },
      }),
    );
    expect(curl.command.split(' \\\n  ')).toEqual([
      `curl 'https://api.test/items'`,
      '-X POST',
      `-H 'X-Token: abc'`,
      `--form-string 'title=Trip'`,
      `--form-string 'note=@home\nline one'`,
      `-F 'avatar=@"photo \\"1\\".jpg";type=image/jpeg'`,
      `-F 'log=@"app.log"'`,
    ]);
    expect(curl.note).toBe('Copied. Files upload from the current folder');
  });

  it('says when the command cannot send the body as the app did', () => {
    expect(toCurl(request({ method: 'PUT', requestBody: { kind: 'binary', size: 10, summary: 'Blob' } }))).toEqual({
      command: `curl 'https://api.test/items' \\\n  -X PUT`,
      note: 'Copied without the body, not captured as text',
    });
    expect(toCurl(request({ method: 'POST', requestBody: { kind: 'text', text: '{"a":', truncated: true } })).note).toBe(
      'Copied with only the beginning of the body',
    );
  });
});

describe('copied text', () => {
  it('turns captured values into plain JSON, saying what was cut', () => {
    const value: SerializedValue = {
      id: 1,
      when: { $t: 'date', v: '2026-10-16T08:00:00.000Z' },
      tags: { $t: 'set', values: ['a', 'b'], size: 3 },
      meta: { $t: 'map', entries: [['k', 1], [{ $t: 'symbol', v: 'Symbol(x)' }, 2]], size: 2 },
      missing: { $t: 'undefined' },
      big: { $t: 'bigint', v: '12' },
      nan: { $t: 'number', v: 'NaN' },
      user: { $t: 'object', name: 'User', props: { name: 'Ada' }, more: 3 },
      note: { $t: 'string', v: 'abc', length: 500 },
      list: { $t: 'array', items: [1, 2], length: 10 },
      save: { $t: 'function', name: 'save' },
    };
    expect(JSON.parse(valueText(value))).toEqual({
      id: 1,
      when: '2026-10-16T08:00:00.000Z',
      tags: ['a', 'b', '… 1 more'],
      meta: { k: 1, 'Symbol(x)': 2 },
      big: '12n',
      nan: 'NaN',
      user: { name: 'Ada', '…': '3 more' },
      note: 'abc… (500 chars)',
      list: [1, 2, '… 8 more'],
      save: 'ƒ save()',
    });
    expect(valueText(value)).toContain('\n  "id": 1,');
    // Plain JSON from storage or a response keeps a `$t` key as an ordinary key.
    expect(JSON.parse(valueText({ $t: 'date', v: 'x' }, true))).toEqual({ $t: 'date', v: 'x' });
    expect(valueText('as is')).toBe('as is');
  });

  it('copies errors with their stack, adding the message when the stack leaves it out', () => {
    const error = (stack: string): SerializedValue => ({ $t: 'error', name: 'TypeError', message: 'boom', stack });
    expect(valueText(error('TypeError: boom\n    at f (app.js:1:1)'))).toBe('TypeError: boom\n    at f (app.js:1:1)');
    expect(valueText(error('f@app.js:1:1'))).toBe('TypeError: boom\nf@app.js:1:1');
    const trace: SerializedValue = { $t: 'error', name: 'Trace', message: '', stack: 'Trace\n    at where (app.js:2:3)' };
    expect(valueText(trace)).toBe('Trace\n    at where (app.js:2:3)');
    expect(valueText({ $t: 'error', name: 'Error', message: '', stack: 'ErrorBoundary@app.js:1:1' })).toBe('Error\nErrorBoundary@app.js:1:1');
  });

  it('writes a log entry as its line, then its objects and errors in full', () => {
    const ts = new Date(2026, 9, 16, 8, 5, 3, 21).getTime();
    const warn: LogEntry = { seq: 1, ts, level: 'warn', source: 'console', args: ['Saved %s', 'draft', { id: 7 }] };
    expect(logEntryText(warn)).toBe('08:05:03.021 WARN  Saved draft {id: 7}\n  {\n    "id": 7\n  }');
    const crash: LogEntry = {
      seq: 2,
      ts,
      level: 'error',
      source: 'uncaught',
      args: [{ $t: 'error', name: 'TypeError', message: 'x is undefined', stack: 'TypeError: x is undefined\n    at App (App.tsx:4:2)' }],
    };
    expect(logEntryText(crash)).toBe(
      '08:05:03.021 ERROR (uncaught) TypeError: x is undefined\n  TypeError: x is undefined\n      at App (App.tsx:4:2)',
    );
  });
});

describe('decodeSocketIo', () => {
  it('names socket.io packets and pulls out event arguments', () => {
    expect(decodeSocketIo('42["chat",{"text":"hi"}]')).toEqual({ label: 'event "chat"', payload: '{"text":"hi"}' });
    expect(decodeSocketIo('42["typing"]')).toEqual({ label: 'event "typing"', payload: undefined });
    expect(decodeSocketIo('42["move",1,2]')).toEqual({ label: 'event "move"', payload: '[1,2]' });
    expect(decodeSocketIo('4212["save",{"id":3}]')).toEqual({ label: 'event "save" #12', payload: '{"id":3}' });
    expect(decodeSocketIo('42/admin,["kick"]')).toEqual({ label: 'event "kick" in /admin', payload: undefined });
    expect(decodeSocketIo('4312[{"ok":true}]')).toEqual({ label: 'ack #12', payload: '[{"ok":true}]' });
    expect(decodeSocketIo('40{"sid":"abc"}')).toEqual({ label: 'connect', payload: '{"sid":"abc"}' });
    expect(decodeSocketIo('44{"message":"Not authorized"}')).toEqual({ label: 'connect error', payload: '{"message":"Not authorized"}' });
    expect(decodeSocketIo('451-["upload",{"_placeholder":true,"num":0}]')).toEqual({
      label: 'binary event "upload"',
      payload: '{"_placeholder":true,"num":0}',
    });
  });

  it('names engine.io packets and leaves other text alone', () => {
    expect(decodeSocketIo('0{"sid":"x","pingInterval":25000}')).toEqual({ label: 'open', payload: '{"sid":"x","pingInterval":25000}' });
    expect(decodeSocketIo('2')).toEqual({ label: 'ping', payload: undefined });
    expect(decodeSocketIo('3')).toEqual({ label: 'pong', payload: undefined });
    expect(decodeSocketIo('{"type":"hello"}')).toBeUndefined();
    expect(decodeSocketIo('9 lives')).toBeUndefined();
  });
});

describe('the Fetch/XHR filter', () => {
  it('takes requests whose kind Metro did not say, and leaves WebSockets and images out', () => {
    expect(['fetch', 'xhr', 'other', 'image', 'websocket'].filter(isFetchOrXhr)).toEqual(['fetch', 'xhr', 'other']);
  });
});

describe('platformLabel and describeSession', () => {
  const session = (fields: Partial<SessionInfo>): SessionInfo => ({
    id: 's1',
    appName: 'shop',
    platform: 'ios',
    sdk: { name: 'dart-vm-service', version: '0.6.0' },
    startedAt: 0,
    ...fields,
  });

  it('names each platform, and passes through ones it does not know', () => {
    expect(platformLabel('linux')).toBe('Linux');
    expect(platformLabel('macos')).toBe('macOS');
    expect(platformLabel('fuchsia' as SessionInfo['platform'])).toBe('fuchsia');
  });

  it('describes an app by its device and runtime, and a page by its browser and host', () => {
    expect(
      describeSession(
        session({ device: { model: 'iPhone Duo', osVersion: 'iOS 27.1', isEmulator: true }, runtime: 'Flutter 3.47.8 · Dart 3.13.7' }),
      ),
    ).toBe('iPhone Duo · iOS 27.1 · emulator · Flutter 3.47.8 · Dart 3.13.7');
    expect(describeSession(session({ platform: 'linux', runtime: 'Flutter 3.47.8 · Dart 3.13.7' }))).toBe(
      'Flutter 3.47.8 · Dart 3.13.7',
    );
    expect(
      describeSession(
        session({
          platform: 'web',
          url: 'http://localhost:5173/cart',
          userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
        }),
      ),
    ).toBe('Chrome 156 · localhost:5173');
  });
});

