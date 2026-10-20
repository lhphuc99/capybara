# @capybara-devtools/react-native

React Native SDK for [Capybara](https://github.com/lhphuc99/capybara#readme): sends your app's logs, network requests (including WebSockets), storage and state to the Capybara UI on your computer, and lets you edit AsyncStorage and MMKV values from it.

On React Native 0.85 or later, Capybara reads logs, network and storage through Metro without this package, except in Expo Go on Android, whose JavaScript engine cannot be debugged. Add it to edit storage, to see storage changes as they happen, to see state, in Expo Go on Android, or on older React Native versions.

```bash
npm install @capybara-devtools/react-native
```

Call `init()` in a file of its own, and import that file on the first line of your entry file:

```ts
// capybara.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { asyncStorage, init, mmkvStorage } from '@capybara-devtools/react-native';
import { storage } from './storage'; // your react-native-mmkv instance

if (__DEV__) init({ appName: 'My app', storage: [asyncStorage(AsyncStorage), mmkvStorage(storage)] });
```

```ts
// index.ts
import './capybara';
import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
```

Called in `index.ts` itself, `init()` would run too late: a file's imports all run before its own code, so your other modules, and the stores they create, would load first.

Then run `npx capybara-devtools` (or open the desktop app) on the computer running Metro. The SDK finds it from the bundle URL, so simulators and phones on the same Wi-Fi connect without configuration. If Capybara runs on another port (`--port`, or `CAPYBARA_PORT`), pass the same `port` to `init()`. `enabled: false` makes `init()` do nothing, to turn it off at run time. In a release build (`__DEV__` false) `init()` does nothing, even without the `if`, unless you pass `allowProduction: true`, for example in an internal test build. Keep the `if` anyway, so the SDK is never set up for your users.

## State

The State tab shows Redux, Zustand, XState, MobX, TanStack Query, SWR and React Context. `init()` picks up Redux Toolkit's `configureStore()`, zustand stores made with `devtools()` and React Context providers on its own, as long as it runs before your store modules load. With Expo Router, that means an entry file of your own (`"main": "index.ts"`) that imports the file calling `init()`, then `expo-router/entry`. The rest take one line each:

```tsx
import { swrMiddleware, watchMobX, watchQueryClient, watchXState, watchZustand } from '@capybara-devtools/react-native';
import * as mobx from 'mobx';

if (__DEV__) {
  watchZustand(useCounterStore, { name: 'counter' }); // a store without devtools()
  watchXState(checkoutActor); // from createActor(machine)
  watchMobX(cartStore, mobx, { name: 'cart' });
  watchQueryClient(queryClient);
}

// SWR's cache here comes from the provider; the middleware watches it and runs the State tab's buttons.
<SWRConfig value={{ provider: () => new Map(), use: __DEV__ ? [swrMiddleware] : [] }}>
  <App />
</SWRConfig>
```

That cache shows as `cache #1`. To name it, make the provider with `swrProvider` as well, next to `use: [swrMiddleware]`: `provider: swrProvider(() => new Map(), { name: 'api' })`.

Redux stores that `init()` cannot see take `capybaraReduxEnhancer()` or `connectReduxStore(store)`, and zustand `devtools()` stores made before it take `watchZustand()`, without action names. Give your contexts a `displayName`, or they take the name of the component that renders their provider. `init()` also turns zustand's `devtools()` on, which then builds a stack trace for every `set` without an action name and, on Hermes, still shows it as `anonymous`: name the actions, set `anonymousActionType` in the `devtools()` options, or pass `init({ state: { redux: false } })` and use `watchZustand` and `capybaraReduxEnhancer()` instead. `init({ state: false })` turns state off; [the README](https://github.com/lhphuc99/capybara#state-redux-zustand-tanstack-query-swr-react-context) has the other options and the limits.

Documentation: [github.com/lhphuc99/capybara](https://github.com/lhphuc99/capybara#optional-react-native-sdk-storage-editing)
