import { useSyncExternalStore } from 'react';

export interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'error';
}

let current: Toast | null = null;
let counter = 0;
let timer: number | undefined;
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

/** Shows a short message at the bottom of the window; a newer one replaces it. */
export function showToast(text: string, tone: Toast['tone'] = 'ok'): void {
  current = { id: ++counter, text, tone };
  emit();
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    current = null;
    emit();
  }, 1_800);
}

export function useToast(): Toast | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => current,
  );
}
