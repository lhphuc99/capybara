# Native simulator fixture: MMKV 3

The MMKV 3 counterpart of [`../native-fixture`](../native-fixture/README.md), which tests MMKV 4. The same rules apply: this is an independent Expo development app with its own bundle identifier (`dev.devsight.mmkv3test`), synthetic data, and no Devsight SDK. Do not use an existing user app or reuse its native binary for this test. Both fixtures can stay installed on the same test simulator.

The fixture pins MMKV 3.3.3 (a C++ TurboModule, no Nitro), AsyncStorage 2.2.0, Expo SDK 57 and React Native 0.86.3. Apart from MMKV and Nitro, its lockfile resolves the same packages as the MMKV 4 fixture. CocoaPods compiles the actual MMKV native implementation.

Copy this directory outside the repository (the tested setup), then from the copy:

```sh
npm ci
npx expo run:ios --device <fixture-simulator-uuid> --port 8096
```

`expo run:ios` opens the app with the Metro URL. To run again later, start `npx expo start --port 8096` in the copy and relaunch the app; it reconnects to the same Metro. Build Devsight from its repository root, then run:

```sh
node packages/cli/scripts/check-mmkv-native.mjs 8096 /tmp/devsight-mmkv3-native-result.json
```

The runner performs the same checks as for MMKV 4, except for private instances created before attachment. Devsight wraps a method that every MMKV 3 instance shares, so such an instance is captured once the app calls one of its methods. The runner checks that it is hidden before that call and readable after it, and that disconnecting restores the original method.
