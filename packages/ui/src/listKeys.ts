import { useCallback, useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

/** A ref that focuses its element once it renders, e.g. the field a click on Edit opened. */
export const focusOnMount = (element: HTMLElement | null) => element?.focus();

/** The row an arrow, Page Up/Down, Home or End key moves to from `index`; undefined for other keys. */
export function movedIndex(key: string, index: number, count: number, page = 10): number | undefined {
  if (count === 0) return undefined;
  switch (key) {
    case 'ArrowDown':
      return Math.min(count - 1, index + 1);
    case 'ArrowUp':
      return Math.max(0, index - 1);
    case 'PageDown':
      return Math.min(count - 1, index + page);
    case 'PageUp':
      return Math.max(0, index - page);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return undefined;
  }
}

interface ListKeys<K> {
  listRef: RefObject<HTMLElement | null>;
  /** The rows' keys, in the order the list shows them; each row carries its key as `data-row`. */
  keys: readonly K[];
  /** For a virtualized list; without it, focusing the row scrolls to it. */
  scrollToIndex?: (index: number) => void;
  /** Makes another row the current one, e.g. selects it. */
  onMove: (key: K) => void;
  /** Enter or Space on a row. */
  onActivate?: (key: K) => void;
}

/**
 * Keyboard moves through a virtualized list whose rows take focus one at a time. Returns the rows' keydown
 * handler, which stays the same between renders so memoized rows keep it.
 */
export function useListKeys<K extends string | number>(options: ListKeys<K>): (event: KeyboardEvent, index: number) => void {
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  return useCallback((event: KeyboardEvent, index: number) => {
    const { listRef, keys, scrollToIndex, onMove, onActivate } = latest.current;
    const key = keys[index];
    if (key === undefined) return;
    if ((event.key === 'Enter' || event.key === ' ') && onActivate) {
      event.preventDefault();
      onActivate(key);
      return;
    }
    const next = movedIndex(event.key, index, keys.length);
    if (next === undefined) return;
    event.preventDefault();
    if (next === index) return;
    const target = keys[next]!;
    onMove(target);
    scrollToIndex?.(next);
    // A virtualized row renders only once scrolled into view.
    requestAnimationFrame(() => {
      const row = listRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(String(target))}"]`);
      row?.focus({ preventScroll: scrollToIndex !== undefined });
    });
  }, []);
}
