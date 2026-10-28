// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatePanel } from '../src/panels/StatePanel';
import { applyStateEvent, emptyStateSlice } from '../src/state';
import type { SessionState } from '../src/store';

const { stateCommand } = vi.hoisted(() => ({ stateCommand: vi.fn() }));
vi.mock('../src/connection', () => ({ stateCommand, send: () => true }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function session(withQueries: boolean): SessionState {
  let state = emptyStateSlice();
  if (withQueries) {
    state = applyStateEvent(state, {
      seq: 1,
      ts: 1_000,
      kind: 'state.store',
      payload: {
        store: { id: 'tanstack-query:1', library: 'tanstack-query', label: 'queries', via: 'client', actions: false, ops: ['refetch'] },
      },
    });
  }
  return {
    meta: {
      info: {
        id: 's1',
        appName: 'Shop',
        platform: 'web',
        sdk: { name: '@capybara-devtools/web', version: '0.5.0' },
        startedAt: 0,
        plugins: ['console', 'network', 'storage', 'state'],
      },
      connected: true,
      lastSeen: 0,
      eventCount: 0,
    },
    loaded: true,
    lastSeq: 1,
    logs: [],
    network: [],
    storageVersions: {},
    state,
  };
}

let container: HTMLElement;
let root: Root;
const callouts = () => [...container.querySelectorAll('.callout.error')].map((element) => element.textContent);

beforeEach(() => {
  localStorage.clear();
  stateCommand.mockReset();
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => act(() => root.unmount()));

describe('StatePanel', () => {
  it('says that a Flutter app read through the Dart VM service needs the package for state, not an npm update', async () => {
    const flutter = session(false);
    flutter.meta.info = { ...flutter.meta.info, platform: 'ios', sdk: { name: 'dart-vm-service', version: '0.6.0' }, plugins: undefined };
    await act(async () => root.render(<StatePanel session={flutter} />));
    expect(container.textContent).toContain('State needs the Capybara package for Flutter');
    expect(container.textContent).not.toMatch(/npm install|init\(\)/);
  });

  it('says when the app did not list its stores, instead of only showing how to add some', async () => {
    stateCommand.mockRejectedValue(new Error('The app did not answer in time'));
    await act(async () => root.render(<StatePanel session={session(false)} />));
    expect(callouts()).toEqual(['Could not ask the app for its stores: The app did not answer in time']);
  });

  it('says when the app did not list its queries', async () => {
    stateCommand.mockImplementation(async (_session: string, method: string) => {
      if (method === 'stores') return [];
      throw new Error('The app did not answer in time');
    });
    await act(async () => root.render(<StatePanel session={session(true)} />));
    expect(callouts()).toEqual(['Could not read the queries from the app: The app did not answer in time']);
  });
});
