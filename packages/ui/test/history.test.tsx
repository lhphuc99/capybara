// @vitest-environment happy-dom
import type { CapybaraEvent, SessionMeta } from '@capybara-devtools/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { receive, useStore } from '../src/store';

const { send } = vi.hoisted(() => ({ send: vi.fn(() => true) }));
vi.mock('../src/connection', () => ({ send }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const meta: SessionMeta = {
  info: { id: 's1', appName: 'Shop', platform: 'web', sdk: { name: 'test', version: '0' }, startedAt: 1 },
  connected: true,
  lastSeen: 1,
  eventCount: 3,
};
const log = (seq: number): CapybaraEvent => ({ seq, ts: seq, kind: 'log', payload: { level: 'log', source: 'console', args: [`#${seq}`] } });

function Probe() {
  const session = useStore((s) => s.sessions.s1);
  return <p>{session ? `${session.loaded ? 'loaded' : 'loading'} ${session.logs.map((entry) => entry.seq).join(',')}` : 'none'}</p>;
}

let container: HTMLElement;
let root: Root;
// The store tells React at most once per 16 ms.
const deliver = (message: Parameters<typeof receive>[0]) =>
  act(async () => {
    receive(message);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

beforeEach(() => {
  send.mockClear();
  container = document.createElement('div');
  root = createRoot(container);
  act(() => root.render(<Probe />));
});

afterEach(() => act(() => root.unmount()));

describe('session history', () => {
  it('is asked for in parts and shown once the last part is in', async () => {
    await deliver({ t: 'init', server: { version: 'test', port: 7357, addresses: [] }, sessions: [meta] });
    expect(send).toHaveBeenCalledWith({ t: 'history', sessionId: 's1', parts: true });

    await deliver({ t: 'history', sessionId: 's1', events: [log(1), log(2)], more: true });
    expect(container.textContent).toBe('loading 1,2');
    await deliver({ t: 'history', sessionId: 's1', events: [log(3)] });
    expect(container.textContent).toBe('loaded 1,2,3');

    // Asked again, e.g. after the server restarted, it starts over.
    await deliver({ t: 'history', sessionId: 's1', events: [log(1)] });
    expect(container.textContent).toBe('loaded 1');
  });
});
