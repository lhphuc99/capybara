import { useState } from 'react';

interface Action {
  label: string;
  run: () => unknown;
}

class Cart {
  items = [
    { sku: 'tea-01', qty: 2 },
    { sku: 'mug-07', qty: 1 },
  ];
  total = 59.9;
}

let socket: WebSocket | undefined;

const groups: Array<{ title: string; actions: Action[] }> = [
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
];

export function App() {
  const [status, setStatus] = useState('Click a button and watch it show up in Devsight.');

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
        <h1>Devsight example</h1>
        <p>
          Run <code>npm start</code> in the repo and open{' '}
          <a href="http://localhost:7357" target="_blank" rel="noreferrer">
            localhost:7357
          </a>{' '}
          next to this tab.
        </p>
      </header>
      {groups.map((group) => (
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
      <p className="status" role="status">
        {status}
      </p>
    </main>
  );
}
