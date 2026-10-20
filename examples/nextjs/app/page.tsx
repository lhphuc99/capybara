'use client';

import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import useSWR, { useSWRConfig } from 'swr';
import { useAuth } from './providers';
import {
  addItem,
  clearCart,
  fetchGreeting,
  getJson,
  postJson,
  useCounterStore,
  useUiStore,
  type AppDispatch,
  type Greeting,
  type RootState,
} from './state';

interface Action {
  label: string;
  run: () => unknown;
}

const actions: Action[] = [
  {
    label: 'console.log an object',
    run: () => console.log('User loaded', { id: 1, name: 'Ada', joined: new Date('2024-03-01'), roles: new Set(['admin']) }),
  },
  { label: 'console.error', run: () => console.error('Payment failed', new Error('Card declined')) },
  { label: 'fetch a route handler', run: () => fetch('/api/hello').then((response) => response.json()) },
  {
    label: 'POST JSON',
    run: () =>
      fetch('/api/hello', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ada' }),
      }).then((response) => response.json()),
  },
  {
    label: 'XHR',
    run: () =>
      new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', '/api/hello?via=xhr');
        xhr.onload = () => resolve(xhr.status);
        xhr.send();
      }),
  },
  {
    label: 'Write storage',
    run: () => {
      localStorage.setItem('theme', 'dark');
      sessionStorage.setItem('draft', 'Hello from Next.js');
      document.cookie = 'consent=yes; path=/';
    },
  },
  { label: 'Read theme', run: () => localStorage.getItem('theme') },
];

const helloQuery = queryOptions({ queryKey: ['hello'], queryFn: () => getJson<Greeting>('/api/hello?via=query') });
const SWR_KEY = '/api/hello?via=swr';

export default function Page() {
  const [result, setResult] = useState('Start Capybara, then try an action.');
  const dispatch = useDispatch<AppDispatch>();
  const cart = useSelector((state: RootState) => state.cart);
  const theme = useUiStore((state) => state.theme);
  const count = useCounterStore((state) => state.count);
  const queryClient = useQueryClient();
  // Mounted here, so the query has an observer and SWR has a hook to revalidate.
  const hello = useQuery(helloQuery);
  const swr = useSWR<Greeting>(SWR_KEY);
  const { mutate } = useSWRConfig();
  const auth = useAuth();
  const greet = useMutation({
    mutationKey: ['greet'],
    mutationFn: (name: string) => postJson<{ received: { name: string } }>('/api/hello', { name }),
  });

  const stateActions: Action[] = [
    {
      label: 'Add tea to the cart (Redux)',
      run: () => dispatch(addItem({ sku: 'tea-01', price: 4.5 })).type,
    },
    { label: 'Clear the cart (Redux)', run: () => dispatch(clearCart()).type },
    {
      label: 'Load a greeting with a thunk (Redux)',
      run: () =>
        dispatch(fetchGreeting())
          .unwrap()
          .then((data) => data.message),
    },
    {
      label: 'Toggle the theme (zustand devtools)',
      run: () => {
        useUiStore.getState().toggleTheme();
        return useUiStore.getState().theme;
      },
    },
    {
      label: 'Count up (zustand + watchZustand)',
      run: () => {
        useCounterStore.getState().increment();
        return useCounterStore.getState().count;
      },
    },
    {
      label: 'Refetch the greeting (TanStack Query)',
      run: () => queryClient.refetchQueries({ queryKey: helloQuery.queryKey, exact: true }).then(() => 'refetched'),
    },
    {
      label: 'Fetch a missing route (404)',
      run: () => queryClient.fetchQuery({ queryKey: ['missing'], queryFn: () => getJson('/api/missing') }),
    },
    {
      label: 'Say hello (TanStack mutation)',
      run: () => greet.mutateAsync('Ada').then((data) => data.received),
    },
    { label: 'Revalidate the greeting (SWR)', run: () => mutate(SWR_KEY).then(() => 'revalidated') },
    { label: 'Sign in (AuthContext)', run: () => auth.signIn() },
    { label: 'Sign out (AuthContext)', run: () => auth.signOut() },
  ];

  async function run(action: Action) {
    try {
      const value = await action.run();
      setResult(`${action.label}: ${value === undefined ? 'done' : JSON.stringify(value)}`);
    } catch (error) {
      setResult(`${action.label}: ${String(error)}`);
    }
  }

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24, maxWidth: 640 }}>
      <h1>Capybara Next.js example</h1>
      <p>
        The SDK starts in <code>instrumentation-client.ts</code>, before the page code runs.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {actions.map((action) => (
          <button key={action.label} type="button" onClick={() => void run(action)}>
            {action.label}
          </button>
        ))}
      </div>
      <h2>State</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {stateActions.map((action) => (
          <button key={action.label} type="button" onClick={() => void run(action)}>
            {action.label}
          </button>
        ))}
      </div>
      <p>
        cart: {cart.items.length} items, {cart.total} · theme: {theme} · count: {count} · query:{' '}
        {hello.data?.via ?? hello.status} · SWR: {swr.data?.via ?? '…'} · auth: {auth.user?.name ?? 'signed out'}
      </p>
      <p id="result" aria-live="polite">
        {result}
      </p>
    </main>
  );
}
