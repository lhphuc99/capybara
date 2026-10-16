# Native and web fixture: react-native-mmkv 4

This is an independent Expo development app, created from the blank TypeScript template. It has its own bundle identifier (`dev.devsight.mmkvtest`), synthetic data, and no Devsight SDK. Do not use an existing user app or reuse its native binary for this test.

The fixture pins react-native-mmkv 4.3.2, Nitro 0.35.9, AsyncStorage 2.2.0, Expo SDK 57 and React Native 0.86.3, plus react-native-web 0.21.4 and react-dom 19.2.3 for the web check. CocoaPods and Gradle compile the actual MMKV/Nitro native implementations. The runner talks to the app through Metro/CDP and sends storage commands through a real Devsight relay.

Create a separate simulator with an available runtime, for example:

```sh
xcrun simctl create Devsight-MMKV-Test com.apple.CoreSimulator.SimDeviceType.iPhone-17 com.apple.CoreSimulator.SimRuntime.iOS-26-5
```

Use the returned UUID explicitly in every command. From this fixture directory:

```sh
npm ci --workspaces=false
npx expo run:ios --device <fixture-simulator-uuid> --port 8095
```

On Android, use a dedicated emulator the same way, for example one created with `avdmanager create avd -n Devsight-Android-Test -k "system-images;android-34;google_apis_playstore;arm64-v8a"`:

```sh
npx expo run:android --device Devsight-Android-Test --port 8095
```

Build Devsight from its repository root, then run:

```sh
node packages/cli/scripts/check-mmkv-native.mjs 8095 /tmp/devsight-mmkv-native-result.json
```

The runner accepts only this app and the MMKV 3 fixture (`dev.devsight.mmkv3test`), and refuses any other target. It verifies exported MMKV, AsyncStorage, private MMKV created after attachment, inferred numbers and booleans against typed native reads, a key outside the BMP, encrypted storage, refreshed values, write rejection and hook cleanup. It also records the expected v4 limitation for a private instance created before attachment. It never resets a simulator or opens another app.

The fixture can also be copied to a temporary directory before installing dependencies. Native build outputs and `node_modules` are ignored. react-native-mmkv 3 has its own fixture, [`../native-fixture-mmkv3`](../native-fixture-mmkv3/README.md).

## Web

With Metro running (`npx expo start --port 8095`), the same app is served to browsers through react-native-web. This loads it in headless Chrome with the Devsight web SDK and checks MMKV's web storage (values in localStorage, edits from Devsight read back by MMKV, change events for app writes, logs and fetch):

```sh
node packages/cli/scripts/check-mmkv-web.mjs http://localhost:8095 /tmp/devsight-mmkv-web-result.json
```

It only runs against the two fixture apps and starts its own Devsight server. Set `CHROME` if Google Chrome is not in `/Applications`.
