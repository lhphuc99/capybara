# Devsight

Debug React Native and web apps from one place: logs, network and storage, streamed live to a local UI.

> Status: MVP, not published to npm yet. "Devsight" is a working name.

## Quick start (from this repo)

```bash
npm install
npm run build
npm start          # UI at http://localhost:7357
npm run desktop    # or the same in a desktop app, see below
```

### React Native / Expo — no SDK needed

Start Metro on the same computer, open your development app on a simulator or phone, then run `npm run desktop` or `npm start` here. Devsight discovers apps on Metro ports **8081 and 8082** and streams console logs, exceptions and network requests into the UI. The Storage tab also reads AsyncStorage and discoverable MMKV instances. No Devsight package installation or code changes in your app are needed.

- Requires Hermes and a Metro inspector target advertising `supportsMultipleDebuggers`. Older targets are skipped so Devsight does not disconnect your existing debugger. Release builds do not expose Metro's inspector.
- Network headers, status and bodies depend on the events your React Native / Expo runtime exposes. React Native's built-in Network support starts at [0.83](https://reactnative.dev/docs/react-native-devtools#network); Expo also provides its own network interceptor. Some Expo versions do not report failed native requests, so those can remain pending. Missing or evicted response bodies cannot be recovered.
- Reloading creates a new session; Metro disconnects are rediscovered automatically. Requests made before the bridge connects are not replayed.
- Apps already using the Devsight SDK are skipped to avoid duplicate sessions.
- **Read-only storage:** Devsight runs a reader through CDP against storage already in your app. It finds AsyncStorage and MMKV instances exposed by initialized Metro module exports (including ESM bindings and exports nested up to two levels). The known AsyncStorage implementation can be loaded from the existing bundle if Metro has deferred it. No new MMKV instances are created, and no keys are written by Devsight.
- **Private MMKV instances:** while connected, Devsight temporarily hooks known MMKV APIs in the running JS runtime. V2/V3 instances are captured when the app next uses their shared method cache, including instances created before connection. V4 instances are captured when the app calls the native factory after the hook is installed. This changes runtime methods, not app source files. The V4 factory accessor may initialize the library's shared factory, but does not open a store. Hooks are restored on disconnect or after an unrenewed 15-second lease (when the app's JS timers can run). At most 100 instances are tracked, using weak references when available.
- In Storage, use **Find stores** after using the relevant app screen, and **Refresh** to read new values. MMKV v4 freezes its native prototypes: an existing private instance cannot be captured merely by reading it again; it must be exported or created after attachment. Modules loaded and used between discovery polls, immutable APIs, custom wrappers and runtimes without Metro module discovery may still be missed. Reloading alone does not guarantee capture because the app may create stores before the bridge attaches. The existing instance retains its encryption configuration; Devsight does not request or guess encryption keys.
- MMKV stores no value types, so Devsight infers them from what each getter can decode. Numbers and booleans display correctly, but `false` and an empty string are stored as the same byte and both show as `false`; binary values may not display. Trying the getters makes MMKV print harmless `[E]` decode messages (such as `getDouble reach end`) to the native log while Devsight reads a store.
- Storage lists are capped at 1,000 keys with 2,000-character previews; selecting a value reads up to 1,000,000 characters. **Editing and automatic storage change notifications still use the SDK.**

For a custom Metro port, or to turn discovery off:

```bash
npm start -- --metro-port 8090                    # repeat for multiple Metro servers
npm start -- --no-metro                          # SDK connections only
```

The desktop app reuses a running CLI server, including its Metro configuration. When that CLI exits, the desktop starts its own server and scans the default ports.

MMKV compatibility targets are the three recent major lines: **2.x, 3.x and 4.x**. Automated checks run against the published JS sources of **2.12.2, 3.3.3 and 4.3.2**, with a simulated native boundary (including Nitro's frozen prototypes). After building, run `npm run test:mmkv-compat -w devsight` to repeat this matrix. It downloads integrity-pinned source archives to a temporary directory, without installing dependencies into your app. Pass a cache directory after `--` to use pre-downloaded archives.

Native **MMKV 4.3.2** and **3.3.3** have been verified end to end on an iOS simulator (Expo SDK 57, React Native 0.86, Hermes), each with a separate test app holding synthetic data: [`packages/cli/test/native-fixture`](packages/cli/test/native-fixture/README.md) and [`packages/cli/test/native-fixture-mmkv3`](packages/cli/test/native-fixture-mmkv3/README.md). Native 2.x (legacy architecture only), Android and physical devices have not been run yet.

### Web (React, Vite, Next.js client)

Import this before the rest of your app so early logs and requests are captured:

```ts
import { init } from '@devsight/web';

if (import.meta.env.DEV) init({ appName: 'My web app' });
```

In Next.js (App Router), put it in a client component rendered from the root layout. On the server `init()` does nothing:

```tsx
// app/devsight.tsx
'use client';
import { init } from '@devsight/web';

if (process.env.NODE_ENV === 'development') init({ appName: 'My Next.js app' });

export default function Devsight() {
  return null;
}
```

### Optional React Native SDK (storage editing)

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { asyncStorage, init } from '@devsight/react-native';

if (__DEV__) init({ appName: 'My app', storage: [asyncStorage(AsyncStorage)] });
```

The SDK finds your machine from the Metro bundle URL, so simulators and phones on the same Wi-Fi connect without configuration. For Android devices over USB the CLI and the desktop app run `adb reverse` for you. Pass `host` to `init()` to override.

## Desktop app

The same server and UI in a window of their own, with a Dock icon and no terminal to keep open. The code is in `apps/desktop` (Electron).

```bash
npm run desktop            # build it and open the window; run `npm run build` once before
npm run desktop:package    # macOS .dmg and .zip in apps/desktop/release/
```

- Apps connect exactly as they do to the CLI, on port 7357. Set `DEVSIGHT_PORT` to use another port.
- If `npx devsight` is already running, the window shows that server, and the app takes over the port once the CLI stops. If another program holds the port, the app says so and lets you try again.
- On macOS, closing the window keeps the server running in the Dock. Quit with ⌘Q.
- Builds are ad-hoc signed and not notarized, so on another Mac the first launch is blocked until you allow it in System Settings → Privacy & Security.
- Needs Node 22.12 or later. Electron downloads its binary (about 130 MB) the first time it runs.

## Examples

```bash
npm run example:web    # Vite app with a mock API, http://localhost:5173
npm run example:expo   # Expo Go; no Devsight SDK loaded, uses Metro discovery
```

The Expo example's AsyncStorage can be read through Metro without loading the Devsight SDK. To test storage editing, add `import './devsight';` as the first import in `examples/expo/index.ts`, then reload the app. The SDK packages are not published yet; outside this workspace, build and `npm pack` the protocol, core and platform SDK packages and install those local archives together.

## Packages

| Package | |
|---|---|
| `devsight` | CLI: local server and UI |
| `@devsight/web` | Browser SDK |
| `@devsight/react-native` | React Native SDK |
| `@devsight/core` | Client runtime and built-in plugins (console, network, storage) |
| `@devsight/protocol` | Wire protocol types |

## Development

```bash
npm test
npm run typecheck
```

To work on the UI with hot reload, run the server with the Vite origin allowed, then start Vite:

```bash
npm start -- --no-open --allow-origin http://localhost:5174
npm run dev:ui
```

Architecture, protocol and roadmap (Vietnamese): [docs/PLAN.md](docs/PLAN.md).
