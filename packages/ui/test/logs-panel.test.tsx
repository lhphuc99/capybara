// @vitest-environment happy-dom
import type { LogEntry } from '@capybara-devtools/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogsPanel } from '../src/panels/LogsPanel';
import type { SessionState } from '../src/store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const log = (seq: number, ...args: LogEntry['args']): LogEntry => ({ seq, ts: seq, level: 'error', source: 'console', args });
const LOGS = [log(1, 'Checkout failed', { $t: 'error', name: 'TypeError', message: 'boom', stack: 'TypeError: boom' }), log(2, 'Later'), log(3, 'Newest', { id: 3 })];

function session(logs: LogEntry[]): SessionState {
  return {
    meta: {
      info: { id: 's1', appName: 'Shop', platform: 'web', sdk: { name: '@capybara-devtools/web', version: '0.5.0' }, startedAt: 0 },
      connected: true,
      lastSeen: 0,
      eventCount: logs.length,
    },
    loaded: true,
    lastSeq: logs.length,
    logs,
    network: [],
    storageVersions: {},
    state: {} as SessionState['state'],
  };
}

const box = (top: number, bottom: number) => ({ x: 0, y: top, top, left: 0, width: 800, height: bottom - top, right: 800, bottom, toJSON: () => ({}) }) as DOMRect;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  // happy-dom lays nothing out: the virtualizer renders no rows into a list of no height, so the list is 400px tall,
  // and the first entry, once open, reaches 100px past its end.
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('log-list') ? 400 : 25;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('log-list')) return box(0, 400);
    return this.querySelector('[data-row="1"]') ? box(300, 500) : box(0, 25);
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const jump = () => [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Jump to latest'));

describe('LogsPanel', () => {
  it('stops following the newest rows when an older entry opens, and scrolls only as far as the entry needs', async () => {
    await act(async () => root.render(<LogsPanel session={session(LOGS)} />));
    expect(jump()).toBeUndefined();
    const list = container.querySelector<HTMLElement>('.log-list')!;
    list.scrollTop = 40;

    const first = container.querySelector<HTMLElement>('[data-row="1"]')!;
    await act(async () => first.click());

    expect(first.getAttribute('aria-expanded')).toBe('true');
    expect(jump()).toBeDefined();
    // Enough to show the end of the entry, which still leaves its first line in view.
    expect(list.scrollTop).toBe(140);
  });

  it('keeps following when the newest entry opens', async () => {
    await act(async () => root.render(<LogsPanel session={session(LOGS)} />));
    const newest = container.querySelector<HTMLElement>('[data-row="3"]')!;
    await act(async () => newest.click());
    expect(newest.getAttribute('aria-expanded')).toBe('true');
    expect(jump()).toBeUndefined();
  });
});
