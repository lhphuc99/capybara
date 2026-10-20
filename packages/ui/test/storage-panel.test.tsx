// @vitest-environment happy-dom
import type { StorageAdapterInfo, StorageEntries } from '@capybara-devtools/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoragePanel } from '../src/panels/StoragePanel';
import type { SessionState } from '../src/store';

const { storageCommand } = vi.hoisted(() => ({ storageCommand: vi.fn() }));
vi.mock('../src/connection', () => ({ storageCommand }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ADAPTERS: StorageAdapterInfo[] = [{ id: 'local', label: 'Local Storage', readOnly: false, canClear: true }];

function session(writes: number): SessionState {
  return {
    meta: {
      info: { id: 's1', appName: 'Shop', platform: 'web', sdk: { name: '@capybara-devtools/web', version: '0.5.0' }, startedAt: 0 },
      connected: true,
      lastSeen: 0,
      eventCount: 0,
    },
    loaded: true,
    lastSeq: 0,
    logs: [],
    network: [],
    storageVersions: { local: writes },
    state: {} as SessionState['state'],
  };
}

const listing = (value: string): StorageEntries => ({ entries: [{ key: 'draft', value, size: value.length, truncated: false }], total: 1 });

let container: HTMLElement;
let root: Root;
const render = (writes: number) => act(async () => root.render(<StoragePanel session={session(writes)} />));
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const reads = () => storageCommand.mock.calls.filter(([, method]) => method === 'entries').length;
const shown = () => container.querySelector('.entry-value')?.textContent;
const refreshButton = () => [...container.querySelectorAll('button')].find((button) => /Refresh|Loading/.test(button.textContent ?? ''));

beforeEach(() => {
  vi.useFakeTimers();
  storageCommand.mockReset();
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe('StoragePanel', () => {
  it('reads a store the app writes all the time every 250 ms, not only once the writes stop', async () => {
    let count = 0;
    storageCommand.mockImplementation(async (_session: string, method: string) =>
      method === 'list' ? ADAPTERS : listing(`v${++count}`),
    );
    await render(0);
    await wait(0);
    expect(reads()).toBe(1);

    // A write every 100 ms for a second.
    for (let writes = 1; writes <= 10; writes++) {
      await render(writes);
      await wait(100);
    }
    expect(reads()).toBe(4);
    expect(shown()).toBe('v4');
    // Reads the app asked for, not the user, leave the button alone.
    expect(refreshButton()?.textContent).toBe('Refresh');

    await wait(300);
    expect(reads()).toBe(5);
    expect(shown()).toBe('v5');
  });

  it('shows replies slower than the writes, but never an older one over a newer one', async () => {
    const replies: Array<(value: StorageEntries) => void> = [];
    storageCommand.mockImplementation((_session: string, method: string) =>
      method === 'list' ? Promise.resolve(ADAPTERS) : new Promise((resolve) => replies.push(resolve)),
    );
    await render(0);
    await wait(0);
    await act(async () => replies[0]!(listing('first')));

    // Each read takes longer than the 250 ms between them.
    for (let writes = 1; writes <= 3; writes++) {
      await render(writes);
      await wait(300);
    }
    expect(replies).toHaveLength(4);

    await act(async () => replies[2]!(listing('third')));
    expect(shown()).toBe('third');
    await act(async () => replies[1]!(listing('second')));
    expect(shown()).toBe('third');
    await act(async () => replies[3]!(listing('fourth')));
    expect(shown()).toBe('fourth');
  });

  it('reads again at once when the user refreshes', async () => {
    let count = 0;
    storageCommand.mockImplementation(async (_session: string, method: string) =>
      method === 'list' ? ADAPTERS : listing(`v${++count}`),
    );
    await render(0);
    await wait(0);
    await act(async () => refreshButton()!.click());
    expect(reads()).toBe(2);
    expect(shown()).toBe('v2');
  });
});
