import { watchZustand } from '@capybara-devtools/web';
import { configureStore, createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

export interface Greeting {
  message: string;
  via: string;
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
    headers: { 'content-type': 'application/json' },
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

export const fetchGreeting = createAsyncThunk('greeting/fetch', () => getJson<Greeting>('/api/hello?via=thunk'));

const greeting = createSlice({
  name: 'greeting',
  initialState: { status: 'idle' as 'idle' | 'loading' | 'failed', message: null as string | null },
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(fetchGreeting.pending, (state) => {
        state.status = 'loading';
      })
      .addCase(fetchGreeting.fulfilled, (state, action) => {
        state.status = 'idle';
        state.message = action.payload.message;
      })
      .addCase(fetchGreeting.rejected, (state) => {
        state.status = 'failed';
      });
  },
});

export const { addItem, clear: clearCart } = cart.actions;

/** A store per request on the server and one for the page in the browser, made in providers.tsx. */
export const makeStore = () =>
  configureStore({
    reducer: { cart: cart.reducer, greeting: greeting.reducer },
    devTools: { name: 'shop' },
  });

export type AppStore = ReturnType<typeof makeStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];

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
if (process.env.NODE_ENV === 'development') watchZustand(useCounterStore, { name: 'counter' });
