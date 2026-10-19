import type { SerializedValue } from '@capybara-devtools/protocol';
import { describe, expect, it } from 'vitest';
import { decodeSocketIo, isFetchOrXhr, logEntryText, valueText } from '../src/format';
import type { LogEntry } from '../src/store';

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
