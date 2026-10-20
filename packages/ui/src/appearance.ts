import { useSyncExternalStore } from 'react';
import { readPref, writePref } from './prefs';

export type Appearance = 'system' | 'light' | 'dark';

declare global {
  interface Window {
    /** Set by the desktop app's preload, so its title bar and native controls follow the choice. */
    capybaraDesktop?: { setAppearance(appearance: Appearance): void };
  }
}

const KEY = 'capybara:appearance';
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

function saved(): Appearance {
  const value = readPref(KEY);
  return value === 'light' || value === 'dark' ? value : 'system';
}

let current = saved();

function apply() {
  const dark = current === 'dark' || (current === 'system' && systemDark.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function setAppearance(next: Appearance): void {
  current = next;
  writePref(KEY, next === 'system' ? null : next);
  window.capybaraDesktop?.setAppearance(next);
  apply();
  for (const listener of listeners) listener();
}

export function useAppearance(): Appearance {
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

systemDark.addEventListener('change', () => {
  if (current === 'system') apply();
});
// The desktop app remembers the last choice for its next launch, but this page's choice wins.
window.capybaraDesktop?.setAppearance(current);
apply();
