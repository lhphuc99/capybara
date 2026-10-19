import { useQuery } from '@tanstack/react-query';
import { useSelector } from 'react-redux';
import { useAuth } from './auth';
import type { RootState } from './redux';
import { useUser } from './swr';
import { usersQuery } from './tanstack';
import { useCounterStore, useUiStore } from './zustand';

/** What the stores hold now. Mounting the hooks also gives the users query an observer and SWR a hook to revalidate. */
export function LiveState() {
  const cart = useSelector((state: RootState) => state.cart);
  const theme = useUiStore((state) => state.theme);
  const count = useCounterStore((state) => state.count);
  const users = useQuery(usersQuery);
  const user = useUser(1);
  const { user: signedIn } = useAuth();

  return (
    <p className="status">
      cart: {cart.items.length} items, {cart.total} · theme: {theme} · count: {count} · users query:{' '}
      {users.data ? users.data.length : users.status} · SWR user 1: {user.data?.name ?? (user.error ? 'error' : '…')} · auth:{' '}
      {signedIn?.name ?? 'signed out'}
    </p>
  );
}
