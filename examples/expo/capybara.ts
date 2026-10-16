import AsyncStorage from '@react-native-async-storage/async-storage';
import { asyncStorage, init } from '@capybara-devtools/react-native';

// Imported first by index.ts so it is set up before the app logs or fetches anything.
if (__DEV__) {
  init({ appName: 'Example Expo app', storage: [asyncStorage(AsyncStorage)] });
}
