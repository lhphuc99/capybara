// @vitest-environment happy-dom
import type { ServerInfo } from '@capybara-devtools/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HintBanner } from '../src/components/HintBanner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const server = (hints?: string[]): ServerInfo => ({ version: '0.5.1', port: 7357, addresses: [], hints });

let container: HTMLElement;
let root: Root;
const render = (info?: ServerInfo) => act(() => root.render(<HintBanner server={info} />));
const shown = () => container.querySelector('.hint-banner span')?.textContent;
const dismiss = () => act(() => container.querySelector<HTMLButtonElement>('.hint-banner button')!.click());

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => act(() => root.unmount()));

describe('HintBanner', () => {
  it('shows the newest hint, then the older ones as they are dismissed', async () => {
    await render(server(['Expo Go on Android cannot be read.', '192.168.1.20 was turned away.']));
    expect(shown()).toBe('192.168.1.20 was turned away.');
    await dismiss();
    expect(shown()).toBe('Expo Go on Android cannot be read.');
    await dismiss();
    expect(container.innerHTML).toBe('');
  });

  it('keeps a dismissed hint hidden after a reload, but shows new ones', async () => {
    await render(server(['192.168.1.20 was turned away.']));
    await dismiss();
    act(() => root.unmount());
    root = createRoot(container);
    await render(server(['192.168.1.20 was turned away.', '192.168.1.31 was turned away.']));
    expect(shown()).toBe('192.168.1.31 was turned away.');
  });

  it('shows nothing for servers without hints', async () => {
    await render(server());
    expect(container.innerHTML).toBe('');
    await render(undefined);
    expect(container.innerHTML).toBe('');
  });
});
