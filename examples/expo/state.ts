import { watchZustand } from '@capybara-devtools/react-native';
import { configureStore, createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { queryOptions } from '@tanstack/react-query';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

export const API = 'https://jsonplaceholder.typicode.com';

export interface User {
  id: number;
  name: string;
  email: string;
}

/** Keeps the status in the message too, which is where the State tab finds it to show "error 404". */
export class HttpError extends Error {
  readonly status: number;

  constructor(method: string, url: string, status: number) {
    super(`${method} ${url} failed with ${status}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new HttpError('GET', url, response.status);
  return (await response.json()) as T;
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new HttpError('POST', url, response.status);
  return (await response.json()) as T;
}

interface CartLine {
  sku: string;
  qty: number;
  price: number;
}

const cart = createSlice({
  name: 'cart',
  initialState: { items: [] as CartLine[], total: 0 },
  reducers: {
    addItem(state, action: PayloadAction<{ sku: string; price: number }>) {
      const line = state.items.find((item) => item.sku === action.payload.sku);
      if (line) line.qty++;
      else state.items.push({ ...action.payload, qty: 1 });
      state.total = Math.round((state.total + action.payload.price) * 100) / 100;
    },
    clear: () => ({ items: [], total: 0 }),
  },
});

export const fetchUsers = createAsyncThunk('users/fetch', () => getJson<User[]>(`${API}/users`));

const users = createSlice({
  name: 'users',
  initialState: { status: 'idle' as 'idle' | 'loading' | 'failed', list: [] as User[] },
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchUsers.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(fetchUsers.fulfilled, (state, action) => {
        state.status = 'idle';
        state.list = action.payload;
      })
      .addCase(fetchUsers.rejected, (state) => {
        state.status = 'failed';
      });
  },
});

export const { addItem, clear: clearCart } = cart.actions;

// Nothing for Capybara here: index.ts imports capybara.ts first, so init() ran before Redux Toolkit loaded and
// configureStore() reports to it through the Redux DevTools hook. `name` is the store's label in the State tab.
export const store = configureStore({
  reducer: { cart: cart.reducer, users: users.reducer },
  devTools: { name: 'shop' },
});

export type RootState = ReturnType<typeof store.getState>;

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
if (__DEV__) watchZustand(useCounterStore, { name: 'counter' });

export const usersQuery = queryOptions({ queryKey: ['users'], queryFn: () => getJson<User[]>(`${API}/users`) });

export const userQuery = (id: number) =>
  queryOptions({ queryKey: ['users', id], queryFn: () => getJson<User>(`${API}/users/${id}`), retry: false });

export const userKey = (id: number) => `${API}/users/${id}`;
