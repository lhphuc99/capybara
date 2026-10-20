import AsyncStorage from '@react-native-async-storage/async-storage';
import { asyncStorage, init } from '@capybara-devtools/react-native';

// Imported first by index.ts, so it is set up before the app logs or fetches anything and before Redux Toolkit loads.
// Off unless Expo starts with EXPO_PUBLIC_CAPYBARA_SDK=1: without the SDK, Capybara still reads logs, network and
// storage through Metro, and edits storage, but not state.
if (__DEV__ && process.env.EXPO_PUBLIC_CAPYBARA_SDK === '1') {
  init({ appName: 'Example Expo app', storage: [asyncStorage(AsyncStorage)] });
}
