import { useLayoutEffect, useState, type RefObject, type WheelEvent } from 'react';

/**
 * Keeps a scrolling list on its newest rows until the user scrolls up. It pins again only when the
 * content height changes: a virtualizer also re-renders while the user scrolls, and pinning on those
 * renders pulled trackpad scrolls, a few pixels per event, back to the bottom.
 */
export function useFollow(ref: RefObject<HTMLElement | null>, contentHeight: number, slack: number) {
  const [follow, setFollow] = useState(true);

  useLayoutEffect(() => {
    const element = ref.current;
    if (follow && element) element.scrollTop = element.scrollHeight;
  }, [ref, follow, contentHeight]);

  const onScroll = () => {
    const element = ref.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (follow && distance >= slack) setFollow(false);
    else if (!follow && distance < 1) setFollow(true);
  };

  // Rows that keep arriving would otherwise pin a slow scroll that has not yet left `slack`.
  const onWheel = (event: WheelEvent) => {
    if (follow && event.deltaY < 0 && (ref.current?.scrollTop ?? 0) > 0) setFollow(false);
  };

  return { follow, setFollow, onScroll, onWheel };
}
