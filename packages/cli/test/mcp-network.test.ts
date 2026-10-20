import type { NetworkEntry } from '@capybara-devtools/protocol';
import { describe, expect, it } from 'vitest';
import { filterRequests, requestLine } from '../src/mcp-network.js';
import { redactor } from '../src/mcp-redact.js';

const redact = redactor(true);
const entry = (id: string, extra: Partial<NetworkEntry>): NetworkEntry => ({
  id,
  seq: Number(id.slice(1)),
  ts: 1_700_000_000_000,
  initiator: 'fetch',
  method: 'GET',
  url: `https://api.test/${id}`,
  requestHeaders: {},
  state: 'done',
  status: 200,
  ...extra,
});

describe('requests in capybara mcp', () => {
  it('searches headers and bodies only when asked, and never the values it hides', () => {
    const requests = [
      entry('r1', { responseBody: { kind: 'text', text: '{"plan":"pro","accessToken":"zzz"}' }, responseHeaders: { 'x-trace': 'abc-42' } }),
      entry('r2', { requestBody: { kind: 'text', text: 'email=a@b.c' } }),
    ];
    const ids = (search: string, inContent?: boolean) => filterRequests(requests, { search, inContent }, redact).map((request) => request.id);
    expect(ids('plan')).toEqual([]);
    expect(ids('plan', true)).toEqual(['r1']);
    expect(ids('abc-42', true)).toEqual(['r1']);
    expect(ids('a@b.c', true)).toEqual(['r2']);
    expect(ids('zzz', true)).toEqual([]);
    expect(ids('/api/users', true)).toEqual([]);
  });

  it('says that a streamed response is still arriving', () => {
    expect(requestLine(entry('r3', { state: 'pending', streaming: true }), redact)).toContain('200 streaming');
  });
});
