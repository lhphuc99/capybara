import { useState } from 'react';
import { mutate } from 'swr';
import { useAuth } from './state/auth';
import { LiveState } from './state/LiveState';
import { addItem, clearCart, fetchUsers, store } from './state/redux';
import { userKey } from './state/swr';
import { login, queryClient, userQuery, usersQuery } from './state/tanstack';
import { useCounterStore, useUiStore } from './state/zustand';

interface Action {
  label: string;
  run: () => unknown;
}

interface Group {
  title: string;
  actions: Action[];
}

class Cart {
  items = [
    { sku: 'tea-01', qty: 2 },
    { sku: 'mug-07', qty: 1 },
  ];
  total = 59.9;
}

let socket: WebSocket | undefined;

const groups: Group[] = [
  {
    title: 'Logs',
    actions: [
      {
        label: 'console.log an object',
        run: () =>
          console.log('User loaded', {
            id: 1,
            name: 'Ada',
            roles: ['admin', 'editor'],
            profile: { city: 'London', joined: new Date('2024-03-01') },
          }),
      },
      {
        label: 'info, warn and error',
        run: () => {
          console.info('Cache warmed in %d ms', 42);
          console.warn('Deprecated API used', { endpoint: '/v1/users' });
          console.error('Payment failed', new Error('Card declined'));
        },
      },
      {
        label: 'Map, Set and a class',
        run: () => console.debug('Collections', new Map([['theme', 'dark']]), new Set([1, 2, 3]), new Cart()),
      },
      {
        label: 'Circular object',
        run: () => {
          const node: Record<string, unknown> = { name: 'root' };
          node.self = node;
          console.log('Circular', node);
        },
      },
      {
        label: 'Log 200 lines',
        run: () => {
          for (let i = 1; i <= 200; i++) console.log(`Line ${i}`, { i, even: i % 2 === 0 });
        },
      },
      {
        label: 'Group, table and count',
        run: () => {
          console.group('Checkout');
          console.table([
            { sku: 'tea-01', qty: 2, price: 12.5 },
            { sku: 'mug-07', qty: 1, price: 34.9 },
          ]);
          console.count('checkout');
          console.groupCollapsed('Shipping');
          console.log('Express, 2 days');
          console.groupEnd();
          console.groupEnd();
        },
      },
      {
        label: 'Time and trace',
        run: async () => {
          console.time('load users');
          await fetch('/api/users');
          console.timeEnd('load users');
          console.trace('Who loaded the users?');
        },
      },
    ],
  },
  {
    title: 'Errors',
    actions: [
      {
        label: 'Throw an uncaught error',
        run: () =>
          setTimeout(() => {
            throw new TypeError("Cannot read properties of undefined (reading 'id')");
          }),
      },
      { label: 'Unhandled rejection', run: () => void Promise.reject(new Error('Session expired')) },
    ],
  },
  {
    title: 'Network',
    actions: [
      {
        label: 'GET /api/users (fetch)',
        run: () =>
          fetch('/api/users')
            .then((r) => r.json())
            .then((list: unknown[]) => `${list.length} users`),
      },
      {
        label: 'POST /api/login (fetch)',
        run: () =>
          fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer demo-token' },
            body: JSON.stringify({ email: 'ada@example.com', password: 'hunter2' }),
          })
            .then((r) => r.json())
            .then((data: { token: string }) => `token ${data.token.slice(0, 12)}…`),
      },
      {
        label: 'GET /api/users/2 (XHR)',
        run: () =>
          new Promise((resolve) => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', '/api/users/2');
            xhr.onload = () => resolve(`status ${xhr.status}`);
            xhr.send();
          }),
      },
      { label: 'Slow request (1.5 s)', run: () => fetch('/api/slow').then((r) => `status ${r.status}`) },
      {
        label: 'Streamed answer (ndjson)',
        run: async () => {
          const response = await fetch('/api/stream');
          const text = await response.text();
          return `${text.trim().split('\n').length} lines`;
        },
      },
      { label: 'Server error (500)', run: () => fetch('/api/error').then((r) => `status ${r.status}`) },
      {
        label: 'Network failure',
        run: () =>
          fetch('http://localhost:59999/unreachable').then(
            () => 'unexpectedly succeeded',
            () => 'failed, as intended',
          ),
      },
    ],
  },
  {
    title: 'WebSocket',
    actions: [
      {
        label: 'Connect to /api/socket',
        run: () =>
          new Promise((resolve, reject) => {
            socket?.close();
            const next = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/socket`, 'chat');
            next.onopen = () => resolve(`connected (${next.protocol})`);
            next.onerror = () => reject(new Error('could not connect'));
            socket = next;
          }),
      },
      {
        label: 'Send a chat message',
        run: () => {
          if (socket?.readyState !== WebSocket.OPEN) return 'connect first';
          socket.send(JSON.stringify({ type: 'chat', text: 'Hello from the example', at: new Date().toISOString() }));
          return 'sent';
        },
      },
      {
        label: 'Send 4 binary bytes',
        run: () => {
          if (socket?.readyState !== WebSocket.OPEN) return 'connect first';
          socket.send(new Uint8Array([1, 2, 3, 4]).buffer);
          return 'sent';
        },
      },
      {
        label: 'Close the socket',
        run: () => {
          socket?.close(1000, 'Closed from the example');
          return 'closing';
        },
      },
      {
        label: 'Fail to connect',
        run: () =>
          new Promise((resolve) => {
            const unreachable = new WebSocket('ws://localhost:59999/nothing');
            unreachable.onclose = (event) => resolve(`closed with code ${event.code}`);
          }),
      },
    ],
  },
  {
    title: 'Storage',
    actions: [
      {
        label: 'Save user to localStorage',
        run: () =>
          localStorage.setItem(
            'user',
            JSON.stringify({ id: 1, name: 'Ada', token: 'abc123', preferences: { theme: 'dark', language: 'vi' } }),
          ),
      },
      {
        label: 'Increment sessionStorage counter',
        run: () => {
          const next = Number(sessionStorage.getItem('counter') ?? 0) + 1;
          sessionStorage.setItem('counter', String(next));
          return `counter = ${next}`;
        },
      },
      {
        label: 'Set a cookie',
        run: () => {
          document.cookie = 'theme=dark; path=/';
        },
      },
      { label: 'Remove user from localStorage', run: () => localStorage.removeItem('user') },
    ],
  },
  {
    title: 'State',
    actions: [
      {
        label: 'Add tea to the cart (Redux)',
        run: () => {
          store.dispatch(addItem({ sku: 'tea-01', price: 4.5 }));
          return `cart total ${store.getState().cart.total}`;
        },
      },
      { label: 'Clear the cart (Redux)', run: () => void store.dispatch(clearCart()) },
      {
        label: 'Load users with a thunk (Redux)',
        run: () =>
          store
            .dispatch(fetchUsers())
            .unwrap()
            .then((list) => `${list.length} users`),
      },
      {
        label: 'Toggle the theme (zustand devtools)',
        run: () => {
          useUiStore.getState().toggleTheme();
          return `theme ${useUiStore.getState().theme}`;
        },
      },
      {
        label: 'Count up (zustand + watchZustand)',
        run: () => {
          useCounterStore.getState().increment();
          return `count ${useCounterStore.getState().count}`;
        },
      },
      {
        label: 'Refetch users (TanStack Query)',
        run: () => queryClient.refetchQueries({ queryKey: usersQuery.queryKey, exact: true }).then(() => 'refetched'),
      },
      { label: 'Fetch a missing user (404)', run: () => queryClient.fetchQuery(userQuery(99)) },
      {
        label: 'Log in (TanStack mutation)',
        run: () => login.mutate('ada@example.com').then((data) => `token ${data.token.slice(0, 12)}…`),
      },
      { label: 'Revalidate user 1 (SWR)', run: () => mutate(userKey(1)).then(() => 'revalidated') },
    ],
  },
];

export function App() {
  const [status, setStatus] = useState('Click a button and watch it show up in Capybara.');
  const auth = useAuth();
  const contextGroup: Group = {
    title: 'React Context',
    actions: [
      {
        label: 'Sign in (AuthContext)',
        run: () => {
          auth.signIn();
          return 'signed in as Ada Lovelace';
        },
      },
      {
        label: 'Sign out (AuthContext)',
        run: () => {
          auth.signOut();
          return 'signed out';
        },
      },
    ],
  };

  const run = async (action: Action) => {
    try {
      const result = await action.run();
      setStatus(`${action.label}: ${typeof result === 'string' ? result : 'done'}`);
    } catch (error) {
      setStatus(`${action.label}: ${(error as Error).message}`);
    }
  };

  return (
    <main className="page">
      <header>
        <h1>Capybara example</h1>
        <p>
          Run <code>npm start</code> in the repo and open{' '}
          <a href="http://localhost:7357" target="_blank" rel="noreferrer">
            localhost:7357
          </a>{' '}
          next to this tab.
        </p>
      </header>
      {[...groups, contextGroup].map((group) => (
        <section key={group.title}>
          <h2>{group.title}</h2>
          <div className="grid">
            {group.actions.map((action) => (
              <button key={action.label} type="button" onClick={() => void run(action)}>
                {action.label}
              </button>
            ))}
          </div>
        </section>
      ))}
      <LiveState />
      <p className="status" role="status">
        {status}
      </p>
    </main>
  );
}
