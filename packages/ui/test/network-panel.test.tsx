// @vitest-environment happy-dom
import type { SessionInfo } from '@capybara-devtools/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NetworkPanel } from '../src/panels/NetworkPanel';
import type { SessionState } from '../src/store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function session(info: Partial<SessionInfo>): SessionState {
  return {
    meta: {
      info: { id: 's1', appName: 'Shop', platform: 'ios', sdk: { name: 'capybara-metro', version: '0.5.0' }, startedAt: 0, ...info },
      connected: true,
      lastSeen: 0,
      eventCount: 0,
    },
    loaded: true,
    lastSeq: 0,
    logs: [],
    network: [],
    storageVersions: {},
    state: {} as SessionState['state'],
  };
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('NetworkPanel', () => {
  it('says that requests are missing when Capybara started reading the app after it had started', async () => {
    await act(async () => root.render(<NetworkPanel session={session({ attachedLate: true })} />));
    expect(container.querySelector('.callout')?.textContent).toContain('after it had started, so earlier requests are missing');
    await act(async () => root.render(<NetworkPanel session={session({ id: 's2' })} />));
    expect(container.querySelector('.callout')).toBeNull();
  });
});
