// @vitest-environment happy-dom
import type { ServerInfo, SessionMeta } from '@capybara-devtools/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachFlutterButton } from '../src/components/AttachFlutter';
import { DartPackagesContext } from '../src/components/DartStack';
import { EmptyState } from '../src/components/EmptyState';
import { JsonTree } from '../src/components/JsonTree';
import { SessionPicker } from '../src/components/SessionPicker';
import { receive, useStore } from '../src/store';

const { send, attachFlutter } = vi.hoisted(() => ({ send: vi.fn(() => true), attachFlutter: vi.fn() }));
vi.mock('../src/connection', () => ({ send, attachFlutter }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STACK = [
  '#0      HomeScreen.build.<anonymous closure> (package:shop/main.dart:44:32)',
  '#1      _ValueListenableBuilderState.build (package:flutter/src/widgets/value_listenable_builder.dart:211:9)',
  '#2      StatefulElement.build (package:flutter/src/widgets/framework.dart:5944:27)',
  '#3      _invoke (dart:ui/hooks.dart:441:13)',
  '#4      _drawFrame (dart:ui/hooks.dart:413:31)',
].join('\n');

const server = (attach: boolean): ServerInfo => ({ version: 'test', port: 7357, addresses: [], flutter: { attach } });
const app: SessionMeta = {
  info: { id: 'f1', appName: 'shop', platform: 'ios', sdk: { name: 'dart-vm-service', version: '0.6.0' }, startedAt: 1 },
  connected: true,
  lastSeen: 1,
  eventCount: 0,
};

let container: HTMLElement;
let root: Root;
const text = () => container.textContent ?? '';
const click = (element: Element | null | undefined) => act(() => (element as HTMLElement).click());
const buttons = (label: string) => [...container.querySelectorAll('button')].filter((b) => b.textContent?.includes(label));
// The store tells React at most once per 16 ms.
const deliver = (message: Parameters<typeof receive>[0]) =>
  act(async () => {
    receive(message);
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
const type = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

beforeEach(() => {
  localStorage.clear();
  attachFlutter.mockReset();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('a Dart stack in the logs', () => {
  it("opens the app's frames and folds the rest by where they come from", async () => {
    const value = { $t: 'error' as const, name: 'StateError', message: 'Bad state', stack: STACK };
    await act(() =>
      root.render(
        <DartPackagesContext.Provider value={{ app: ['shop'] }}>
          <JsonTree value={value} expandDepth={1} />
        </DartPackagesContext.Provider>,
      ),
    );
    expect([...container.querySelectorAll('.frame.app .f-name')].map((e) => e.textContent)).toEqual(['HomeScreen.build.<anonymous closure>']);
    expect([...container.querySelectorAll('.fold-text')].map((e) => e.textContent)).toEqual(['2 frames from flutter', '2 frames from dart:ui']);
    await click(container.querySelector('.fold'));
    expect([...container.querySelectorAll('.frame.dim .f-name')].map((e) => e.textContent)).toEqual([
      '_ValueListenableBuilderState.build',
      'StatefulElement.build',
    ]);
  });

  it('leaves a JS stack as it was', async () => {
    const value = { $t: 'error' as const, name: 'Error', message: 'boom', stack: 'Error: boom\n    at run (http://localhost:5173/src/App.tsx:4:9)' };
    await act(() => root.render(<JsonTree value={value} expandDepth={1} />));
    expect(container.querySelector('.frame')).toBeNull();
    expect(text()).toContain('at run (http://localhost:5173/src/App.tsx:4:9)');
  });
});

describe('the onboarding', () => {
  it('shows one platform at a time and remembers the one chosen', async () => {
    await deliver({ t: 'init', server: server(true), sessions: [] });
    await act(() => root.render(<EmptyState status="open" server={server(true)} />));
    expect(text()).toContain('Start Metro on this computer');
    await click(buttons('Flutter')[0]);
    expect(text()).toContain('flutter run');
    expect(container.querySelector('input[aria-label="Dart VM service address"]')).not.toBeNull();
    expect(localStorage.getItem('capybara:onboarding-platform')).toBe('flutter');
  });

  it('has no address field on another device, which the server would turn away', async () => {
    localStorage.setItem('capybara:onboarding-platform', 'flutter');
    await deliver({ t: 'init', server: server(false), sessions: [] });
    await act(() => root.render(<EmptyState status="open" server={server(false)} />));
    expect(text()).toContain('flutter run');
    expect(container.querySelector('input[aria-label="Dart VM service address"]')).toBeNull();
  });
});

describe('connecting a Flutter app by address', () => {
  it('sends the address, then forgets it', async () => {
    attachFlutter.mockResolvedValue({ appName: 'shop' });
    await deliver({ t: 'init', server: server(true), sessions: [app] });
    await act(() => root.render(<AttachFlutterButton />));
    await click(buttons('Connect a Flutter app')[0]);
    const input = container.querySelector<HTMLInputElement>('.attach-panel input')!;
    await type(input, ' http://127.0.0.1:50300/abc=/ ');
    await act(async () => input.form!.requestSubmit());
    expect(attachFlutter).toHaveBeenCalledWith('http://127.0.0.1:50300/abc=/');
    // The panel closes once the app is read.
    expect(container.querySelector('.attach-panel')).toBeNull();
  });

  it("shows the server's answer when the address is wrong", async () => {
    attachFlutter.mockRejectedValue(new Error('No Flutter app answers at that address.'));
    await deliver({ t: 'init', server: server(true), sessions: [app] });
    await act(() => root.render(<AttachFlutterButton />));
    await click(buttons('Connect a Flutter app')[0]);
    const input = container.querySelector<HTMLInputElement>('.attach-panel input')!;
    await type(input, 'http://127.0.0.1:1/nope=/');
    await act(async () => input.form!.requestSubmit());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('No Flutter app answers at that address.');
    expect(input.value).toBe('http://127.0.0.1:1/nope=/');
  });

  it('is the last item of the app menu', async () => {
    await deliver({ t: 'init', server: server(true), sessions: [app] });
    function Picker() {
      return <SessionPicker sessions={useStore((s) => s.sessions)} selectedId={useStore((s) => s.selectedId)} />;
    }
    await act(() => root.render(<Picker />));
    await click(container.querySelector('.picker-button'));
    expect(container.querySelector('[role="listbox"] .picker-attach')).toBeNull();
    await click(buttons('Connect a Flutter app by address')[0]);
    expect(container.querySelector('.picker-attach input')).not.toBeNull();
  });
});
