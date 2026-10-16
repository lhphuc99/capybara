import AsyncStorage from '@react-native-async-storage/async-storage';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useColorScheme, View } from 'react-native';

const API = 'https://jsonplaceholder.typicode.com';

interface Action {
  label: string;
  run: () => unknown;
}

const groups: Array<{ title: string; actions: Action[] }> = [
  {
    title: 'Logs',
    actions: [
      {
        label: 'console.log an object',
        run: () =>
          console.log('User loaded', { id: 1, name: 'Ada', roles: ['admin', 'editor'], joined: new Date('2024-03-01') }),
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
        label: 'Map and Set',
        run: () => console.debug('Collections', new Map([['theme', 'dark']]), new Set([1, 2, 3])),
      },
      {
        label: 'Unhandled rejection',
        run: () => void Promise.reject(new Error('Session expired')),
      },
    ],
  },
  {
    title: 'Network',
    actions: [
      {
        label: 'GET /users (fetch)',
        run: () =>
          fetch(`${API}/users`)
            .then((r) => r.json())
            .then((list: unknown[]) => `${list.length} users`),
      },
      {
        label: 'POST /posts (fetch)',
        run: () =>
          fetch(`${API}/posts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Hello', body: 'From Devsight', userId: 1 }),
          }).then((r) => `status ${r.status}`),
      },
      {
        label: 'GET /todos/1 (XHR)',
        run: () =>
          new Promise((resolve) => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', `${API}/todos/1`);
            xhr.onload = () => resolve(`status ${xhr.status}`);
            xhr.onerror = () => resolve('failed');
            xhr.send();
          }),
      },
      { label: 'Not found (404)', run: () => fetch(`${API}/missing-route`).then((r) => `status ${r.status}`) },
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
    title: 'AsyncStorage',
    actions: [
      {
        label: 'Save user',
        run: () =>
          AsyncStorage.setItem('user', JSON.stringify({ id: 1, name: 'Ada', token: 'abc123', theme: 'dark' })),
      },
      {
        label: 'Increment counter',
        run: async () => {
          const next = Number((await AsyncStorage.getItem('counter')) ?? 0) + 1;
          await AsyncStorage.setItem('counter', String(next));
          return `counter = ${next}`;
        },
      },
      { label: 'Remove user', run: () => AsyncStorage.removeItem('user') },
    ],
  },
];

export default function App() {
  const dark = useColorScheme() === 'dark';
  const [status, setStatus] = useState('Tap a button and watch it show up in Devsight.');
  const colors = dark ? darkColors : lightColors;

  const run = async (action: Action) => {
    try {
      const result = await action.run();
      setStatus(`${action.label}: ${typeof result === 'string' ? result : 'done'}`);
    } catch (error) {
      setStatus(`${action.label}: ${(error as Error).message}`);
    }
  };

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={styles.content}>
      <Text style={[styles.title, { color: colors.text }]}>Devsight example</Text>
      <Text style={[styles.subtitle, { color: colors.muted }]}>
        Run `npm start` in the repo, then open localhost:7357 on your computer.
      </Text>
      {groups.map((group) => (
        <View key={group.title} style={styles.group}>
          <Text style={[styles.groupTitle, { color: colors.muted }]}>{group.title.toUpperCase()}</Text>
          {group.actions.map((action) => (
            <Pressable
              key={action.label}
              onPress={() => void run(action)}
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: colors.card, borderColor: colors.border },
                pressed && { borderColor: colors.accent },
              ]}
            >
              <Text style={[styles.buttonText, { color: colors.text }]}>{action.label}</Text>
            </Pressable>
          ))}
        </View>
      ))}
      <Text style={[styles.status, { color: colors.muted, borderColor: colors.border }]}>{status}</Text>
    </ScrollView>
  );
}

const lightColors = { bg: '#fafafa', card: '#ffffff', text: '#1f2328', muted: '#5f6872', border: '#e3e7ec', accent: '#1a6fe0' };
const darkColors = { bg: '#0e1116', card: '#151a21', text: '#e6edf3', muted: '#9aa3ad', border: '#252c36', accent: '#4f8fff' };

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingTop: 72, paddingBottom: 48 },
  title: { fontSize: 26, fontWeight: '700' },
  subtitle: { marginTop: 4, fontSize: 14 },
  group: { marginTop: 24, gap: 8 },
  groupTitle: { fontSize: 12, fontWeight: '600', letterSpacing: 0.6 },
  button: { paddingVertical: 12, paddingHorizontal: 14, borderWidth: 1, borderRadius: 10 },
  buttonText: { fontSize: 15 },
  status: { marginTop: 28, padding: 12, borderWidth: 1, borderStyle: 'dashed', borderRadius: 10, fontSize: 13 },
});
