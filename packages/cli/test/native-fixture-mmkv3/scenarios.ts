import AsyncStorage from '@react-native-async-storage/async-storage';
import { MMKV } from 'react-native-mmkv';

const listeners = new Set<(message: string) => void>();
function report(message: string) {
  for (const listener of listeners) listener(message);
  console.log('[Capybara native fixture]', message);
}
export function subscribe(listener: (message: string) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function seed(store: MMKV, label: string) {
  store.set('message', label);
  store.set('unicode', 'Xin chào 😀');
  store.set('json', JSON.stringify({ fixture: true, label }));
  store.set('count', 42);
  store.set('ratio', 3.14);
  store.set('enabled', false);
  store.set('visible', true);
  store.set('short', 'abc');
  store.set('emoji 😀', 'astral key');
}
export const exportedStore = new MMKV({ id: 'capybara-fixture-exported' });
seed(exportedStore, 'exported native store');

// These instances are intentionally reachable only through closures. No global/SDK registry.
const privateActions = (() => {
  const before = new MMKV({ id: 'capybara-fixture-private-before' });
  seed(before, 'private before connection');
  let after: MMKV | undefined;
  let encrypted: MMKV | undefined;
  return {
    readBefore() { return before.getString('message'); },
    createAfter() {
      after = new MMKV({ id: 'capybara-fixture-private-after' });
      seed(after, 'private after connection');
      // The Jest mock would expose plain JS functions here, not JSI host functions.
      const native = (after as unknown as { nativeInstance: { getString: unknown } }).nativeInstance;
      return { message: after.getString('message'), nativeGetString: String(native.getString) };
    },
    createEncrypted() {
      encrypted = new MMKV({ id: 'capybara-fixture-encrypted', encryptionKey: 'fixture-only-key' });
      seed(encrypted, 'encrypted native store');
      return encrypted.getString('message');
    },
    changeAfter() { after?.set('message', 'changed by the app'); return after?.getString('message'); },
    nativeValues() {
      return {
        count: after?.getNumber('count'), ratio: after?.getNumber('ratio'),
        enabled: after?.getBoolean('enabled'), visible: after?.getBoolean('visible'),
      };
    },
    readAfter() { return after?.getString('message'); },
  };
})();

export async function runTestAction(action: string) {
  if (action === 'seedAsync') {
    await AsyncStorage.setItem('capybara-fixture-async', 'native AsyncStorage');
    return true;
  }
  if (!(action in privateActions)) throw new Error('Unknown fixture action');
  const result = privateActions[action as keyof typeof privateActions]();
  report(action + ' completed');
  return result;
}
