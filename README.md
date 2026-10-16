<img src="assets/icon.svg" width="96" alt="">

# Capybara

Debug React Native and web apps from one place: logs, network (including WebSockets) and storage, streamed live to a local UI.

> Status: MVP, not published to npm yet. Formerly called Devsight.

## Quick start (from this repo)

```bash
npm install
npm run build
npm start          # UI at http://localhost:7357
npm run desktop    # or the same in a desktop app, see below
```

### React Native / Expo — no SDK needed

Start Metro on the same computer, open your development app on a simulator or phone, then run `npm run desktop` or `npm start` here. Capybara discovers apps on Metro ports **8081 and 8082** and streams console logs, exceptions and network requests into the UI. The Storage tab also reads AsyncStorage and discoverable MMKV instances. No Capybara package installation or code changes in your app are needed.

- Requires Hermes and **React Native 0.85 or later**, whose Metro inspector targets advertise `supportsMultipleDebuggers`. On older versions a new debugger disconnects the existing one, so Capybara skips those targets; use the SDK there. Release builds do not expose Metro's inspector.
- Network headers, status and bodies depend on the events your React Native / Expo runtime exposes. React Native's built-in Network support starts at [0.83](https://reactnative.dev/docs/react-native-devtools#network); Expo also provides its own network interceptor. Some Expo versions do not report failed native requests, so those can remain pending. Expo's native `fetch` (`expo/fetch`) is reported only when `expo-dev-client` or Expo Go sets up Expo's network inspector; in other debug builds (seen on Android) those requests do not appear without the SDK, while XHR and axios requests still do. Missing or evicted response bodies cannot be recovered.
- **WebSockets:** while connected, Capybara hooks the app's `WebSocket` (reporting through `Runtime.addBinding`) and records connections and messages: text up to 16 KiB per message, binary as its size. React Native dispatches socket events from JS, so sockets opened before Capybara attached, and sockets made through a constructor a library saved earlier (socket.io's engine.io does), are recorded from their next event on. Sockets of dev tools (Metro, React DevTools on 8097, Reactotron on 9090) are skipped. The hook is removed on disconnect or after an unrenewed 15-second lease.
- Reloading creates a new session; Metro disconnects are rediscovered automatically. Requests made before the bridge connects are not replayed.
- Apps already using the Capybara SDK are skipped to avoid duplicate sessions.
- **Read-only storage:** Capybara runs a reader through CDP against storage already in your app. It finds AsyncStorage and MMKV instances exposed by initialized Metro module exports (including ESM bindings and exports nested up to two levels). The known AsyncStorage implementation can be loaded from the existing bundle if Metro has deferred it. No new MMKV instances are created, and no keys are written by Capybara.
- **Private MMKV instances:** while connected, Capybara temporarily hooks known `react-native-mmkv` APIs in the running JS runtime. 3.x instances are captured when the app next uses their shared method cache, including instances created before connection. 4.x instances are captured when the app calls the native factory after the hook is installed. This changes runtime methods, not app source files. The 4.x factory accessor may initialize the library's shared factory, but does not open a store. Hooks are restored on disconnect or after an unrenewed 15-second lease (when the app's JS timers can run). At most 100 instances are tracked, using weak references when available.
- In Storage, use **Find stores** after using the relevant app screen, and **Refresh** to read new values. `react-native-mmkv` 4.x freezes its native prototypes: an existing private instance cannot be captured merely by reading it again; it must be exported or created after attachment. Modules loaded and used between discovery polls, immutable APIs, custom wrappers and runtimes without Metro module discovery may still be missed. Reloading alone does not guarantee capture because the app may create stores before the bridge attaches. The existing instance retains its encryption configuration; Capybara does not request or guess encryption keys.
- MMKV stores no value types, so Capybara infers them from what each getter can decode. Numbers and booleans display correctly, but `false` and an empty string are stored as the same byte and both show as `false`; binary values may not display. Trying the getters makes MMKV print harmless `[E]` decode messages (such as `getDouble reach end`) to the native log while Capybara reads a store.
- Storage lists are capped at 1,000 keys with 2,000-character previews; selecting a value reads up to 1,000,000 characters. **Editing and automatic storage change notifications still use the SDK.**

For a custom Metro port, or to turn discovery off:

```bash
npm start -- --metro-port 8090                    # repeat for multiple Metro servers
npm start -- --no-metro                          # SDK connections only
```

The desktop app reuses a running CLI server, including its Metro configuration. When that CLI exits, the desktop starts its own server and scans the default ports.

MMKV versions here are those of the [`react-native-mmkv`](https://github.com/mrousavy/react-native-mmkv) package, not of the Tencent MMKV core it bundles (the core is at 2.x). Targets are **3.x and 4.x**; 2.x needs React Native's legacy architecture and is out of scope. Automated checks run against the published JS sources of **3.3.3 and 4.3.2** (and 2.12.2, which shares the 3.x hook), with a simulated native boundary (including Nitro's frozen prototypes). After building, run `npm run test:mmkv-compat -w capybara` to repeat this matrix. It downloads integrity-pinned source archives to a temporary directory, without installing dependencies into your app. Pass a cache directory after `--` to use pre-downloaded archives.

Native **react-native-mmkv 4.3.2** and **3.3.3** have been verified end to end on an iOS simulator, and 4.3.2 also on an Android emulator (Expo SDK 57, React Native 0.86, Hermes), each with a separate test app holding synthetic data: [`packages/cli/test/native-fixture`](packages/cli/test/native-fixture/README.md) and [`packages/cli/test/native-fixture-mmkv3`](packages/cli/test/native-fixture-mmkv3/README.md). The same apps run on the web through react-native-web, where `packages/cli/scripts/check-mmkv-web.mjs` checks MMKV's web storage through the web SDK. Metro discovery has not been run on a physical device yet.

### Web (React, Vite, Next.js client)

Import this before the rest of your app so early logs and requests are captured:

```ts
import { init } from '@capybara/web';

if (import.meta.env.DEV) init({ appName: 'My web app' });
```

In Next.js 15.3 or later, put it in `instrumentation-client.ts` at the project root. Next.js runs that file in the browser before your app's code, and production builds drop the call:

```ts
// instrumentation-client.ts
import { init } from '@capybara/web';

if (process.env.NODE_ENV === 'development') init({ appName: 'My Next.js app' });
```

On older versions, call it at the top of a client component rendered from the root layout; on the server `init()` does nothing. Requests the Next.js dev overlay makes for itself (`/__nextjs_*`) are not recorded, and server-side logs and requests are not captured yet. See [`examples/nextjs`](examples/nextjs).

- WebSockets the page creates after `init()` are recorded, which is another reason to import the SDK first. Dev server sockets (Vite, Next.js and Metro HMR) are skipped.
- React's "Download the React DevTools" notice, which its development build prints on every page load, is not recorded. It still prints in the browser console.
- Cookie writes refresh the Storage tab automatically where the Cookie Store API exists (such as Chrome); elsewhere use Refresh.
- `react-native-mmkv` on the web keeps values as text in localStorage under `<id>\<key>`, so they appear in **Local Storage** with their exact values. Edits made there are read by MMKV, but listeners from `addOnValueChangedListener` (and hooks built on them) are not notified. Instances that fall back to memory because localStorage is blocked are not visible.

### Why a request failed

Browsers never tell a page why a request failed: `fetch` rejects with "Failed to fetch", and the reason (CORS, a refused connection, a blocked port) appears only in the browser's own console. Capybara explains failures in two steps:

- The web SDK tells apart offline, mixed content (an https page calling `http://`) and Content-Security-Policy blocks, and marks other cross-origin failures. Chrome lets https pages call LAN IPs and `.local` hosts over http, so in Chrome those are not reported as mixed content.
- For the rest, **Find out why** in the request's Response tab asks the Capybara server to repeat the request's CORS steps from your computer: the preflight, then GET and HEAD requests with the page's `Origin`, following redirects. The server reads the headers the browser hid and applies the browser's rules, so it can name the cause: a missing or wrong `Access-Control-Allow-Origin`, duplicated values, `*` with cookies, a missing `Access-Control-Allow-Credentials`, a preflight that fails or leaves out a method or header, `Origin: null` after a redirect between two other sites, or a host that cannot be reached (DNS, refused connection, TLS, a port browsers block).

Capybara never sends the app's `Authorization` header or cookies. It does not send other methods again, since they could change data, and asks the server with `OPTIONS` instead. A server that answers signed-in users differently can therefore behave differently in the browser. The checks run from your computer, so for a page on a phone that calls `localhost`, Capybara reaches a different machine than the phone did.

React Native has no CORS. With the SDK, failed XHR and axios requests (and `fetch` in bare React Native, which runs on XHR) show the error text from the native networking layer instead of "Network request failed".

### Optional React Native SDK (storage editing)

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { asyncStorage, init, mmkvStorage } from '@capybara/react-native';
import { storage } from './storage'; // your react-native-mmkv instance

if (__DEV__) init({ appName: 'My app', storage: [asyncStorage(AsyncStorage), mmkvStorage(storage)] });
```

The SDK also works below React Native 0.85, where Metro discovery is not available. WebSockets are recorded by default; pass `network: { websocket: false }` to turn that off, or `maxMessageSize` to change the 16 KiB message preview. Socket URLs are shown as the app opened them, query string included, and some apps put an auth token there.

In the UI, WebSocket connections are **WS** rows in the Network tab. Select one to see its messages, filter them by text or direction, and inspect JSON payloads; socket.io frames are decoded into event names and arguments.

The SDK finds your machine from the Metro bundle URL, so simulators and phones on the same Wi-Fi connect without configuration. For Android devices over USB the CLI and the desktop app run `adb reverse` for you. Pass `host` to `init()` to override.

## Desktop app

The same server and UI in a window of their own, with a Dock icon and no terminal to keep open. The code is in `apps/desktop` (Electron).

```bash
npm run desktop            # build it and open the window; run `npm run build` once before
npm run desktop:package    # macOS .dmg and .zip in apps/desktop/release/
```

- Apps connect exactly as they do to the CLI, on port 7357. Set `CAPYBARA_PORT` to use another port.
- If `npx capybara` is already running, the window shows that server, and the app takes over the port once the CLI stops. If another program holds the port, the app says so and lets you try again.
- On macOS, closing the window keeps the server running in the Dock. Quit with ⌘Q.
- Builds are ad-hoc signed and not notarized, so on another Mac the first launch is blocked until you allow it in System Settings → Privacy & Security.
- Needs Node 22.12 or later. Electron downloads its binary (about 130 MB) the first time it runs.
- Packaging needs Xcode 26 or later. The app icon (`apps/desktop/build/icon.icon`, an Icon Composer file) is compiled with Xcode's `actool`, which also produces the `.icns` that older macOS versions use. The source artwork is [`assets/icon.svg`](assets/icon.svg).

## Examples

```bash
npm run example:web     # Vite app with a mock API, http://localhost:5173
npm run example:nextjs  # Next.js App Router with a route handler, http://localhost:3005
npm run example:expo    # Expo Go; no Capybara SDK loaded, uses Metro discovery
```

The Expo example's AsyncStorage can be read through Metro without loading the Capybara SDK. To test storage editing, add `import './capybara';` as the first import in `examples/expo/index.ts`, then reload the app. The SDK packages are not published yet; outside this workspace, build and `npm pack` the protocol, core and platform SDK packages and install those local archives together.

## Packages

| Package | |
|---|---|
| `capybara` | CLI: local server and UI |
| `@capybara/web` | Browser SDK |
| `@capybara/react-native` | React Native SDK |
| `@capybara/core` | Client runtime and built-in plugins (console, network, storage) |
| `@capybara/protocol` | Wire protocol types |

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
