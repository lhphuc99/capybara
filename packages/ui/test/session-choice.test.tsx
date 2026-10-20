// @vitest-environment happy-dom
import type { SessionMeta } from '@capybara-devtools/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { receive, useStore } from '../src/store';

const { send } = vi.hoisted(() => ({ send: vi.fn(() => true) }));
vi.mock('../src/connection', () => ({ send }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const app = (id: string, startedAt: number, extra: Partial<SessionMeta> = {}): SessionMeta => ({
  info: { id, appName: 'Shop', platform: 'ios', sdk: { name: 'test', version: '0' }, startedAt },
  connected: true,
  lastSeen: startedAt,
  eventCount: 0,
  ...extra,
});

function Probe() {
  return <p>{useStore((s) => s.selectedId) ?? 'none'}</p>;
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
  container = document.createElement('div');
  root = createRoot(container);
  act(() => root.render(<Probe />));
});

afterEach(() => act(() => root.unmount()));

describe('the app on screen', () => {
  it('is one on this computer before a newer one from another device, which a reload does not follow either', async () => {
    const server = { version: 'test', port: 7357, addresses: [] };
    await deliver({ t: 'init', server, sessions: [app('simulator', 1), app('stranger', 2, { address: '192.168.1.66' })] });
    expect(container.textContent).toBe('simulator');

    // The simulator's app reloads: its old session goes offline, and a look-alike from the network connects first.
    await deliver({ t: 'session', session: app('simulator', 1, { connected: false }) });
    await deliver({ t: 'session', session: app('look-alike', 3, { address: '192.168.1.66' }) });
    expect(container.textContent).toBe('simulator');
    await deliver({ t: 'session', session: app('simulator-reloaded', 4) });
    expect(container.textContent).toBe('simulator-reloaded');
  });
});
