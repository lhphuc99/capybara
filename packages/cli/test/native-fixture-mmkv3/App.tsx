import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { runTestAction, subscribe } from './scenarios';

export default function App() {
  const [status, setStatus] = useState('Ready for the Capybara native test runner');
  useEffect(() => subscribe(setStatus), []);
  useEffect(() => { void runTestAction('seedAsync'); }, []);
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Capybara MMKV 3 Test</Text>
      <Text style={styles.text}>Isolated sample app · no Capybara SDK</Text>
      <Text style={styles.text}>Native MMKV 3.3.3 · Hermes</Text>
      <Text style={styles.status}>{status}</Text>
      <Text style={styles.text}>The runner checks exported storage, private storage, encrypted storage, and hook cleanup through Metro.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 28, justifyContent: 'center', backgroundColor: '#111827', gap: 20 },
  title: { color: '#ffffff', fontSize: 28, fontWeight: '700' },
  text: { color: '#cbd5e1', fontSize: 16, lineHeight: 24 },
  status: { color: '#86efac', fontSize: 18, lineHeight: 26 },
});
