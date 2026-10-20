// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonTree } from '../src/components/JsonTree';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
const rows = () => container.querySelectorAll('.tree-row:not(.tree-branch):not(.tree-more)').length;
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('.tree-more button')].find((b) => b.textContent?.startsWith(text));

beforeEach(() => {
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => act(() => root.unmount()));

describe('JsonTree', () => {
  it('shows a large array 100 children at a time', async () => {
    await act(() => root.render(<JsonTree value={Array.from({ length: 250 }, (_, i) => i)} raw expandDepth={1} />));
    expect(rows()).toBe(100);
    expect(button('Show 100 more')).toBeDefined();
    expect(button('Show all')?.textContent).toBe('Show all 150');
    await act(() => button('Show 100 more')!.click());
    expect(rows()).toBe(200);
    expect(button('Show 50 more')).toBeDefined();
    expect(button('Show all')).toBeUndefined();
    await act(() => button('Show 50 more')!.click());
    expect(rows()).toBe(250);
    expect(container.querySelector('.tree-more')).toBeNull();
  });

  it('says how many items the app did not send', async () => {
    await act(() => root.render(<JsonTree value={{ $t: 'array', items: [1, 2], length: 40 }} expandDepth={1} />));
    expect(container.textContent).toContain('… 38 more, not sent by the app');
  });
});
