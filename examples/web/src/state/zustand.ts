import { watchZustand } from '@capybara-devtools/web';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

interface UiState {
  theme: 'light' | 'dark';
  toggleTheme: () => void;
}

// devtools() reports to Capybara with each action's name. Naming them also spares zustand a stack trace on every
// set(), which it takes to guess a name when there is no Redux DevTools extension.
export const useUiStore = create<UiState>()(
  devtools(
    (set) => ({
      theme: 'light',
      toggleTheme: () => set((state) => ({ theme: state.theme === 'light' ? 'dark' : 'light' }), false, 'ui/toggleTheme'),
    }),
    { name: 'ui' },
  ),
);

interface CounterState {
  count: number;
  updatedAt: string | null;
  increment: () => void;
}

export const useCounterStore = create<CounterState>()((set) => ({
  count: 0,
  updatedAt: null,
  increment: () => set((state) => ({ count: state.count + 1, updatedAt: new Date().toISOString() })),
}));

// A store without devtools() needs this line. Its changes show which paths changed, without action names.
if (import.meta.env.DEV) watchZustand(useCounterStore, { name: 'counter' });
