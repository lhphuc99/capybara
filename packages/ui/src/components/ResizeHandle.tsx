import { useState, type RefObject } from 'react';

/** Width of a side pane in percent of its container, remembered across launches. */
export function usePaneWidth(key: string, fallback: number) {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(key));
      return saved > 0 ? saved : fallback;
    } catch {
      return fallback;
    }
  });
  const save = (value: number) => {
    try {
      localStorage.setItem(key, value.toFixed(1));
    } catch {
      // not essential
    }
  };
  const reset = () => {
    setWidth(fallback);
    try {
      localStorage.removeItem(key);
    } catch {
      // not essential
    }
  };
  return { width, setWidth, save, reset };
}

interface Props {
  /** The grid whose last column the handle resizes; the handle sits on that column's left edge. */
  container: RefObject<HTMLElement | null>;
  /** Width of the last column, in percent of the container. */
  width: number;
  min: number;
  max: number;
  onChange: (width: number) => void;
  /** Called once a drag or key press is done, to remember the width. */
  onCommit: (width: number) => void;
  onReset: () => void;
  label: string;
}

export function ResizeHandle({ container, width, min, max, onChange, onCommit, onReset, label }: Props) {
  const [dragging, setDragging] = useState(false);
  const clamp = (value: number) => Math.min(max, Math.max(min, value));

  return (
    <div
      className={`resize-handle${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={(event) => {
        const box = container.current?.getBoundingClientRect();
        if (event.button !== 0 || !box) return;
        event.preventDefault();
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Capture is refused for some synthetic pointers; the window listeners below still see the drag.
        }
        setDragging(true);
        document.body.classList.add('resizing');
        let latest = width;
        const move = (moved: PointerEvent) => {
          latest = clamp(((box.right - moved.clientX) / box.width) * 100);
          onChange(latest);
        };
        const end = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', end);
          window.removeEventListener('pointercancel', end);
          document.body.classList.remove('resizing');
          setDragging(false);
          onCommit(latest);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', end);
        window.addEventListener('pointercancel', end);
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        // The handle is on the pane's left edge, so moving it left widens the pane.
        const step = event.shiftKey ? 10 : 2;
        const next = clamp(width + (event.key === 'ArrowLeft' ? step : -step));
        onChange(next);
        onCommit(next);
      }}
    />
  );
}
