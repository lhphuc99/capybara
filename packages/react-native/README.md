# @capybara-devtools/react-native

React Native SDK for [Capybara](https://github.com/lhphuc99/capybara#readme): sends your app's logs, network requests (including WebSockets) and storage to the Capybara UI on your computer, and lets you edit AsyncStorage and MMKV values from it.

On React Native 0.85 or later, Capybara reads logs, network and storage through Metro without this package. Add it to edit storage, to see storage changes as they happen, or on older React Native versions.

```bash
npm install @capybara-devtools/react-native
```

Import it before the rest of your app:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { asyncStorage, init, mmkvStorage } from '@capybara-devtools/react-native';
import { storage } from './storage'; // your react-native-mmkv instance

if (__DEV__) init({ appName: 'My app', storage: [asyncStorage(AsyncStorage), mmkvStorage(storage)] });
```

Then run `npx capybara-devtools` (or open the desktop app) on the computer running Metro. The SDK finds it from the bundle URL, so simulators and phones on the same Wi-Fi connect without configuration.

Documentation: [github.com/lhphuc99/capybara](https://github.com/lhphuc99/capybara#optional-react-native-sdk-storage-editing)
