'use client';

import { useState } from 'react';

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

export default function Page() {
  const [result, setResult] = useState('Start Capybara, then try an action.');

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
          <button key={action.label} onClick={() => void run(action)}>
            {action.label}
          </button>
        ))}
      </div>
      <p id="result" aria-live="polite">
        {result}
      </p>
    </main>
  );
}
