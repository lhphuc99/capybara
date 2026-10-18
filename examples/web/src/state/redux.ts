import { configureStore, createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { getJson, type User } from './api';

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

export const fetchUsers = createAsyncThunk('users/fetch', () => getJson<User[]>('/api/users'));

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

// Nothing for Capybara here: init() in capybara.ts ran before Redux Toolkit loaded, so configureStore() reports to it
// through the Redux DevTools hook. `name` is the store's label in the State tab.
export const store = configureStore({
  reducer: { cart: cart.reducer, users: users.reducer },
  devTools: { name: 'shop' },
});

export type RootState = ReturnType<typeof store.getState>;
