<img src="assets/icon.svg" width="96" alt="">

# Capybara

Debug React Native and web apps from one place: logs, network (including WebSockets), storage and state (Redux, Zustand, TanStack Query, SWR, React Context), streamed live to a local UI.

**[Website](https://capybara-devtools.chanieshop.com)** · [Download](https://capybara-devtools.chanieshop.com/#download)

> Status: MVP. Formerly called Devsight.

## Quick start

```bash
npx capybara-devtools    # UI at http://localhost:7357
```

Or use the [desktop app](#desktop-app). From this repo:

```bash
npm install
npm run build
npm start          # UI at http://localhost:7357
npm run desktop    # or the same in a desktop app, see below
```

The UI opens only on the computer Capybara runs on, while apps connect from any device on your network. To open it from another device, start Capybara with `--remote-ui`, or set `CAPYBARA_REMOTE_UI=1` (the desktop app reads it too); that device then sees everything apps send, tokens included. A device that is turned away gets a page saying so, and the CLI prints its address, which the UI also shows in a banner. The device button at the top right of the UI shows the address to copy and a QR code to scan with a phone or tablet, or the flag to restart with.

An AI assistant can add the SDK to your app for you: see [Set up Capybara with an AI assistant](#set-up-capybara-with-an-ai-assistant).

When a newer version is on npm, `npx capybara-devtools` says so when it starts, and the UI shows a notice when a connected app uses an older SDK, with the command that updates it. The server asks the npm registry (the one npm is set up with) when it starts and twice a day; `--no-update-check` or `CAPYBARA_NO_UPDATE_CHECK=1` turns that off.

### React Native / Expo — no SDK needed

Start Metro on the same computer, open your development app on a simulator or phone, then run `npm run desktop` or `npm start` here. Capybara discovers apps on Metro ports **8081 and 8082** and streams console logs, exceptions and network requests into the UI. The Storage tab also reads AsyncStorage and discoverable MMKV instances. No Capybara package installation or code changes in your app are needed. The State tab still needs the [SDK](#state-redux-zustand-tanstack-query-swr-react-context).

- Requires Hermes and **React Native 0.85 or later**, whose Metro inspector targets advertise `supportsMultipleDebuggers`. On older versions a new debugger disconnects the existing one, so Capybara skips those targets; use the SDK there. Release builds do not expose Metro's inspector.
- **Expo Go on Android cannot be read through Metro**: its JavaScript engine does not support debugging, so Capybara opens no session for it and the CLI prints a hint once. Use the SDK or a development build there. Expo Go on iOS works.
- Network headers, status and bodies depend on the events your React Native / Expo runtime exposes. React Native's built-in Network support starts at [0.83](https://reactnative.dev/docs/react-native-devtools#network); Expo also provides its own network interceptor. Some Expo versions do not report failed native requests, so those can remain pending. Expo's native `fetch` (`expo/fetch`) is reported only when `expo-dev-client` or Expo Go sets up Expo's network inspector; in other debug builds (seen on Android) those requests do not appear without the SDK, while XHR and axios requests still do. Expo's inspector does not say whether `fetch` or XHR made a request, so in Expo Go requests show as `other`, under the Fetch/XHR filter. Missing or evicted response bodies cannot be recovered.
- **Stack traces** point into your source files (`App.tsx:48:52`), with or without the SDK: Capybara asks Metro to map them, as LogBox does. This needs Metro on the same computer as Capybara.
- **WebSockets:** while connected, Capybara hooks the app's `WebSocket` (reporting through `Runtime.addBinding`) and records connections and messages: text up to 16 KiB per message, binary as its size. React Native dispatches socket events from JS, so sockets opened before Capybara attached, and sockets made through a constructor a library saved earlier (socket.io's engine.io does), are recorded from their next event on. Sockets of dev tools (Metro, React DevTools on 8097, Reactotron on 9090) are skipped. The hook is removed on disconnect or after an unrenewed 15-second lease.
- Reloading creates a new session; Metro disconnects are rediscovered automatically. Requests made before the bridge connects are not replayed.
- If an app does not show up, or shows without its requests, start the CLI with `CAPYBARA_DEBUG=1`: it prints when it attaches to an app, when it leaves one to its SDK, and what failed on the way, such as a CDP domain the runtime does not support.
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

MMKV versions here are those of the [`react-native-mmkv`](https://github.com/mrousavy/react-native-mmkv) package, not of the Tencent MMKV core it bundles (the core is at 2.x). Targets are **3.x and 4.x**; 2.x needs React Native's legacy architecture and is out of scope. Automated checks run against the published JS sources of **3.3.3 and 4.3.2** (and 2.12.2, which shares the 3.x hook), with a simulated native boundary (including Nitro's frozen prototypes). After building, run `npm run test:mmkv-compat -w capybara-devtools` to repeat this matrix. It downloads integrity-pinned source archives to a temporary directory, without installing dependencies into your app. Pass a cache directory after `--` to use pre-downloaded archives.

Native **react-native-mmkv 4.3.2** and **3.3.3** have been verified end to end on an iOS simulator, and 4.3.2 also on an Android emulator (Expo SDK 57, React Native 0.86, Hermes), each with a separate test app holding synthetic data: [`packages/cli/test/native-fixture`](packages/cli/test/native-fixture/README.md) and [`packages/cli/test/native-fixture-mmkv3`](packages/cli/test/native-fixture-mmkv3/README.md). The same apps run on the web through react-native-web, where `packages/cli/scripts/check-mmkv-web.mjs` checks MMKV's web storage through the web SDK. Metro discovery has not been run on a physical device yet.

### Web (React, Vite, Next.js client)

Call `init()` in a file of its own, and import that file on the first line of your entry file so early logs and requests are captured:

```ts
// capybara.ts
import { init } from '@capybara-devtools/web';

if (import.meta.env.DEV) init({ appName: 'My web app' });
```

```ts
// main.tsx
import './capybara';
import { createRoot } from 'react-dom/client';
import App from './App';
```

Called in `main.tsx` itself, `init()` would run too late: a file's imports all run before its own code, so your other modules, and the stores they create, would load first.

If Capybara runs on another port (`--port`, or `CAPYBARA_PORT`), pass the same `port` to `init()`. `enabled: false` makes `init()` do nothing, to turn it off at run time; unlike the `if`, it leaves the SDK in production builds. In a production build (`NODE_ENV=production`) `init()` does nothing, even without the `if`, unless you pass `allowProduction: true`, for example in a staging build for testers. Keep the `if` anyway: it also keeps the SDK out of the bundle.

In Next.js 15.3 or later, put it in `instrumentation-client.ts` at the project root. Next.js runs that file in the browser before your app's code, and production builds drop the call:

```ts
// instrumentation-client.ts
import { init } from '@capybara-devtools/web';

if (process.env.NODE_ENV === 'development') init({ appName: 'My Next.js app' });
```

On older versions, call it at the top of a client component rendered from the root layout; on the server `init()` does nothing. Requests the Next.js dev overlay makes for itself (`/__nextjs_*`) are not recorded, and server-side logs and requests are not captured yet. See [`examples/nextjs`](examples/nextjs).

- WebSockets the page creates after `init()` are recorded, which is another reason to import the SDK first. Dev server sockets (Vite, Next.js and Metro HMR) are skipped.
- React's "Download the React DevTools" notice, which its development build prints on every page load, is not recorded. It still prints in the browser console.
- Cookie writes refresh the Storage tab automatically where the Cookie Store API exists (such as Chrome); elsewhere use Refresh.
- `react-native-mmkv` on the web keeps values as text in localStorage under `<id>\<key>`, so they appear in **Local Storage** with their exact values. Edits made there are read by MMKV, but listeners from `addOnValueChangedListener` (and hooks built on them) are not notified. Instances that fall back to memory because localStorage is blocked are not visible.

### State (Redux, Zustand, TanStack Query, SWR, React Context)

With the web or React Native SDK, the **State** tab shows the app's stores, grouped by library. Redux, Zustand and React Context have a timeline of changes with their diffs, and the current state as a tree; Redux stores and zustand's `devtools()` stores also name the action behind each change. TanStack Query and SWR list their entries by status with each one's data, and buttons to refetch, invalidate, reset, cancel or remove a query, or to revalidate, clear or reset an SWR key. Apart from those buttons the tab only reads: no dispatching, editing or time travel yet. Update the CLI or the desktop app together with the SDK; an older one keeps state events in the same history as logs, which can push logs out.

`init()` turns it on, and has to run before your store modules load: Redux Toolkit looks for the Redux DevTools extension once, when it is imported, and zustand's `devtools()` when it creates the store. Calling `init()` in a file of its own, imported on the first line of the entry file as shown for [the web](#web-react-vite-nextjs-client) and [React Native](#optional-react-native-sdk-storage-editing), does that. In Next.js, `instrumentation-client.ts` runs early enough (checked with the App Router of Next.js 16.4, on Turbopack and webpack). With Expo Router, give the app an entry file that imports it first:

```ts
// index.ts, with "main": "index.ts" in package.json
import './capybara'; // the file that calls init()
import 'expo-router/entry';
```

These show up on their own: Redux Toolkit's `configureStore()`, plain Redux stores created with `window.__REDUX_DEVTOOLS_EXTENSION__?.()`, zustand stores made with `devtools()`, and React Context providers. `init()` stands in for the Redux DevTools extension, or wraps it when it is installed, so the Redux and zustand stores report with action names; their `name` option (`devTools: { name }` in Redux Toolkit) labels them. Context is read through React DevTools' hook, from development builds of React. Contexts of libraries (react-redux, TanStack Query, React Navigation…) are hidden behind **Show library contexts**. A context is listed under its `displayName`; without one it takes the name of the component that renders its provider, and a second unnamed context there shows as `#2` (`AuthProvider #2`), so set `displayName` on your contexts (`AuthContext.displayName = 'Auth'`).

The rest take one line each. These can run before or after `init()`, do nothing on the server, return a function that stops watching, and also come from `@capybara-devtools/react-native`:

```ts
import { watchQueryClient, watchSWR, watchZustand } from '@capybara-devtools/web';
import { SWRConfig } from 'swr';

if (import.meta.env.DEV) {
  watchZustand(useCounterStore, { name: 'counter' }); // without devtools(): diffs, no action names
  watchQueryClient(queryClient); // give each client a name when there are several
  watchSWR(SWRConfig); // SWR's default cache
}
```

Watch a `QueryClient` made in a component, as in Next.js, from an effect: StrictMode runs `useState` initializers twice, and the client it throws away would show up too.

```tsx
const [queryClient] = useState(() => new QueryClient());
useEffect(() => {
  if (process.env.NODE_ENV === 'development') return watchQueryClient(queryClient);
}, [queryClient]);
```

An `SWRConfig` with a `provider` of its own, as React Native apps have, needs `swrMiddleware`. It also hands the State tab the `mutate` its buttons use, which `provider: swrProvider(...)` alone cannot. In Next.js, such an `SWRConfig` goes in a `'use client'` file.

```tsx
import { swrMiddleware } from '@capybara-devtools/react-native';

<SWRConfig value={{ provider: () => new Map(), use: __DEV__ ? [swrMiddleware] : [] }}>
  <App />
</SWRConfig>
```

That cache shows as `cache #1`. To name it, make the provider with `swrProvider` as well, next to `use: [swrMiddleware]`: `provider: swrProvider(() => new Map(), { name: 'api' })`.

A Redux store created before `init()`, by a Redux Toolkit imported before it, or with `devTools: false` needs the enhancer. For a store that exists already, `connectReduxStore(store)` is a best effort: actions dispatched by thunks and middleware show as "unknown action". A zustand store made with `devtools()` before `init()` is missed too; `watchZustand()` shows it, without action names.

```ts
import { capybaraReduxEnhancer } from '@capybara-devtools/web';

export const store = configureStore({
  reducer,
  enhancers: (getDefaultEnhancers) =>
    import.meta.env.DEV ? getDefaultEnhancers().concat(capybaraReduxEnhancer({ name: 'shop' })) : getDefaultEnhancers(),
});
```

`init({ state: false })` turns state off. An object sets it up instead, e.g. `init({ state: { context: false } })`:

- `redux: false` leaves the Redux DevTools globals alone. Redux Toolkit and `devtools()` stores then need the enhancer or `watchZustand`.
- `context: false` turns React Context off.
- `maxActionsPerSecond` (default 30): changes to a store beyond that are folded into its next record, marked as skipped.
- `actionsDenylist`: action types kept off the timeline, as strings (the whole type) or regular expressions. Their changes show in the next record.
- `sanitizeState(state, store)` and `sanitizeAction(action, store)`: only what they return leaves the app. `sanitizeState` does not apply to TanStack Query or SWR data.
- `hideFunctions` (default true) leaves out keys that hold functions, such as zustand actions.

The Redux DevTools options that hold data back (`stateSanitizer`, `actionSanitizer`, `actionsDenylist`, `actionsAllowlist`, `predicate`) apply too, given in Redux Toolkit's `devTools` or in the options of zustand's `devtools()`.

Limits:

- Changes are found by comparing references, so a change made in place, to the same object, is not recorded. The current state is read from the app, so it shows such a change.
- Where the Redux DevTools extension is missing, always the case on React Native, `init()` turns zustand's `devtools()` on, and each `set` without an action name makes zustand build a stack trace to guess one. That costs time on Hermes for stores that change often, and the guess often fails, so such actions show as `anonymous`: Hermes stack traces do not name the caller, and on the web Vite's dependency pre-bundling breaks the guess (seen in Chrome). Name the actions on every platform (`set(fn, false, 'cart/add')`), set `anonymousActionType` in the `devtools()` options, or pass `state: { redux: false }`.
- Other libraries that report through the Redux DevTools extension's `connect()`, such as Valtio's and Jotai's devtools, show under Zustand.
- React Context: without the React DevTools extension or Fast Refresh, `init()` has to run before `react-dom` loads. At most 40 of the app's contexts and 20 of libraries' are shown. Providers of one context under one name are one store: with up to 20, its state holds each provider's value under its React key; past that, the value that changed last. Library contexts are recognized by name, and on the web also by coming from `node_modules`. React Native has no file paths: there Capybara knows the contexts of React Native, React Navigation and Expo Router (checked with Expo Router 58's Stack, Tabs and NativeTabs), while those of UI kits such as Tamagui or gluestack show as the app's own; `context: false` turns Context off.
- SWR keys served only from `fallback` are not in the cache, so they show up once SWR fetches them.
- React Native apps found through Metro without the SDK show no state.

### Why a request failed

Browsers never tell a page why a request failed: `fetch` rejects with "Failed to fetch", and the reason (CORS, a refused connection, a blocked port) appears only in the browser's own console. Capybara explains failures in two steps:

- The web SDK tells apart offline, mixed content (an https page calling `http://`) and Content-Security-Policy blocks, and marks other cross-origin failures. Chrome lets https pages call LAN IPs and `.local` hosts over http, so in Chrome those are not reported as mixed content.
- For the rest, **Find out why** in the request's Response tab asks the Capybara server to repeat the request's CORS steps from your computer: the preflight, then GET and HEAD requests with the page's `Origin`, following redirects. The server reads the headers the browser hid and applies the browser's rules, so it can name the cause: a missing or wrong `Access-Control-Allow-Origin`, duplicated values, `*` with cookies, a missing `Access-Control-Allow-Credentials`, a preflight that fails or leaves out a method or header, `Origin: null` after a redirect between two other sites, or a host that cannot be reached (DNS, refused connection, TLS, a port browsers block).

Capybara never sends the app's `Authorization` header or cookies. It does not send other methods again, since they could change data, and asks the server with `OPTIONS` instead. A server that answers signed-in users differently can therefore behave differently in the browser. The checks run from your computer, so for a page on a phone that calls `localhost`, Capybara reaches a different machine than the phone did.

React Native has no CORS. With the SDK, failed XHR and axios requests (and `fetch` in bare React Native, which runs on XHR) show the error text from the native networking layer instead of "Network request failed".

### Optional React Native SDK (storage editing)

As on [the web](#web-react-vite-nextjs-client), call `init()` in a file of its own and import it on the first line of the app's entry file:

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

The SDK also works below React Native 0.85, where Metro discovery is not available, and it is what the [State tab](#state-redux-zustand-tanstack-query-swr-react-context) needs. In a release build (`__DEV__` false) `init()` does nothing, even without the `if`, unless you pass `allowProduction: true`, for example in an internal test build. WebSockets are recorded by default; pass `network: { websocket: false }` to turn that off, or `maxMessageSize` to change the 16 KiB message preview. Socket URLs are shown as the app opened them, query string included, and some apps put an auth token there.

In the UI, WebSocket connections are **WS** rows in the Network tab. Select one to see its messages, filter them by text or direction, and inspect JSON payloads; socket.io frames are decoded into event names and arguments.

To share what you see, **Copy all** in the Logs tab copies the entries that match the current filters as text, and the copy icon that appears when you hover over an entry copies just that one. Objects are copied in full as JSON and errors with their stack. In the Storage tab, **Copy** copies the selected value, and every object or value in a JSON tree has its own copy icon.

Drag the line between the request list and its details (or between the keys and the value in the Storage tab) to resize them; double-click it to reset. The same goes for the line between the Path and Host columns, between a store's keys and values, and beside the list of stores in the Storage and State tabs, so long URLs, keys and names show in full. With a line focused, the arrow keys move it too. Widths are remembered.

The **Appearance** button at the top right switches between System (the default, following your OS), Light and Dark. In the macOS desktop app the window's title bar follows it too.

The SDK finds your machine from the Metro bundle URL, so simulators and phones on the same Wi-Fi connect without configuration. For Android devices over USB the CLI and the desktop app run `adb reverse` for you, again whenever a device reconnects. Pass `host` to `init()` to override, and `port` when Capybara runs on another port (`--port`, or `CAPYBARA_PORT`).

## Desktop app

The same server and UI in a window of their own, with a Dock or taskbar icon and no terminal to keep open. The code is in `apps/desktop` (Electron).

Download it from the [website](https://capybara-devtools.chanieshop.com/#download) or [GitHub Releases](https://github.com/lhphuc99/capybara/releases), or build it yourself from a clone of this repo, after `npm install`:

```bash
npm run desktop                  # build it and open the window; run `npm run build` once before
npm run desktop:package          # macOS: .dmg and .zip
npm run desktop:package:win      # Windows x64: installer (.exe) and .zip
npm run desktop:package:linux    # Linux x64 and arm64: .AppImage and .tar.gz
npm run desktop:package:all      # all three
```

Packages land in `apps/desktop/release/`, named like `Capybara-0.1.0-win-x64.exe`. A Mac builds all three without Wine or Docker; the macOS package can only be built on a Mac.

- Apps connect exactly as they do to the CLI, on port 7357. Set `CAPYBARA_PORT` to use another port, and `CAPYBARA_REMOTE_UI=1` to let other devices open the UI. What the CLI would print, such as a device that was turned away or an app that can't be read through Metro, shows in a banner at the top of the window.
- If `npx capybara-devtools` is already running, the window shows that server, and the app takes over the port once the CLI stops. If another program holds the port, the app says so and lets you try again. The other way round, `npx capybara-devtools` started while the app runs opens the app's UI and exits.
- On macOS, closing the window keeps the server running in the Dock. Quit with ⌘Q. On Windows and Linux, closing the window quits.
- No build is signed for distribution. On another Mac the first launch is blocked until you allow it in System Settings → Privacy & Security. On Windows, SmartScreen warns about an unknown publisher: choose More info → Run anyway.
- Updates: the app looks for a new GitHub release 10 seconds after it starts and twice a day, and asks before doing anything. The Windows installer and the AppImage download the update, then restart into it; the macOS app, the Windows zip and the tar.gz open the release page to download it. **Check for Updates…** is in the Capybara menu on macOS and the Help menu elsewhere. `CAPYBARA_NO_UPDATE_CHECK=1` turns the automatic checks off.
- Windows: the installer installs for the current user, without admin rights. On first launch Windows Firewall asks about network access; allow it on private networks if phones connect over Wi-Fi. Apps on the same computer, emulators and USB devices connect through localhost and don't need it.
- Linux: `chmod +x` the AppImage, then run it; it doesn't need libfuse2. Ubuntu 24.04 and later block the user namespaces that Chromium's sandbox needs. There the AppImage starts without the sandbox, while `capybara-desktop` from the tar.gz refuses to start until you pass `--no-sandbox` or make `chrome-sandbox` owned by root with mode 4755.
- Needs Node 22.12 or later. Electron downloads its binary (about 130 MB) the first time it runs.
- The macOS package needs Xcode 26 or later. The app icon (`apps/desktop/build/icon.icon`, an Icon Composer file) is compiled with Xcode's `actool`, which also produces the `.icns` that older macOS versions use. Windows and Linux use `apps/desktop/build/icon.png`; after changing the source artwork, [`assets/icon.svg`](assets/icon.svg), regenerate it on a Mac with `npm run icon -w @capybara-devtools/desktop`.

## AI assistants (MCP)

`capybara mcp` lets an AI assistant read and filter what Capybara records: logs, network requests, WebSocket messages, storage and state. It is an [MCP](https://modelcontextprotocol.io) server on stdin and stdout that reads the Capybara app or `npx capybara-devtools` already running on this computer.

```bash
claude mcp add capybara -- npx capybara-devtools mcp    # Claude Code
```

For Claude Desktop, Cursor and other clients, add it to their MCP settings:

```json
{ "mcpServers": { "capybara": { "command": "npx", "args": ["capybara-devtools", "mcp"] } } }
```

### Set up Capybara with an AI assistant

With the MCP server added, ask the assistant to "set up Capybara in this project" (in Claude Code, `/mcp__capybara__setup` does the same). It calls `get_setup_guide`, which reads the app's package.json and lockfile and says what to change in that app: the SDK to install with its package manager, the file that calls `init()` and where to import it (`instrumentation-client.ts` in Next.js 15.3 and later, an entry file of its own with Expo Router), and the line each state library needs. The guide changes no file: the assistant makes the changes, and once the app runs, checks with `list_sessions` that it connects. At a monorepo's root the guide lists the apps to choose from.

An assistant without the MCP server gets the same guide from a command, followed by how to add the server:

```bash
npx capybara-devtools setup-guide            # the app in this folder, or pass its folder
```

| Tool | What it reads |
| --- | --- |
| `get_setup_guide` | How to add Capybara to an app, worked out from its package.json. Works before Capybara runs |
| `list_sessions` | Connected apps and their session ids |
| `get_logs` | Logs, filtered by level, text or `/regex/` and source (uncaught errors, unhandled rejections); one entry in full by `seq` |
| `get_network` | Requests and WebSockets, one per line, filtered by status (`404`, `5xx`, `failed`), method, URL, type and duration |
| `get_request` | One request with its headers and bodies |
| `diagnose_request` | Why a request from a web page failed, the same check as **Find out why** |
| `get_websocket` | The messages of one WebSocket |
| `get_storage` | The app's stores, their keys, or one value |
| `get_state` | The app's state stores with their ids and latest change, or one store's current state, whole or at a `path` such as `cart.items[0]` |
| `get_state_actions` | Changes to the stores, newest last: the action and the paths it changed, with skipped and missed changes marked; one change in full by `seq`. Works after the app disconnects |
| `get_queries` | TanStack Query and SWR entries, filtered by status (`error`, `pending`, `success`, `fetching`, `stale`) or key; one entry's data by `key` |

- The tools only read. `diagnose_request` sends the request's preflight and, for GET and HEAD, the request itself again from this computer, without the app's credentials.
- What the tools return goes to the AI model. Values that look like credentials are replaced with `[hidden]`: Authorization and cookie headers, JSON keys and query parameters such as `token`, `password`, `jwt` or `privateKey`, and storage keys such as `authToken`. In state, so are values at a path through such a key, the rest of an action whose type names one (`auth/setToken`), and the data of a query or SWR key named like one. JWTs, `Bearer …` values and Stripe, GitHub, Slack and AWS keys are hidden in the keys and errors of queries and SWR entries. Empty values (`null`, `undefined`, `false`, `''`) are shown as they are, so a signed-out app reads differently from a signed-in one. A credential under an ordinary name still reaches the model, as in storage. Pass `--show-secrets` to turn that off.
- Lists return the newest 50 entries by default; pass `after` with the last `seq` to get only newer ones. Without a session id, the tools read the newest connected app.
- Pass `--port` when Capybara runs on another port, and `--host` to read Capybara on another computer, which must run with `--remote-ui`.

## Examples

```bash
npm run example:web     # Vite app with a mock API, http://localhost:5173
npm run example:nextjs  # Next.js App Router with a route handler, http://localhost:3005
npm run example:expo    # Expo Go; no Capybara SDK unless EXPO_PUBLIC_CAPYBARA_SDK=1
```

Each example has a store of each state library and a React Context, with buttons that change them. The Expo example loads no Capybara SDK by default, so it shows what Capybara reads through Metro, AsyncStorage included. Start it with `EXPO_PUBLIC_CAPYBARA_SDK=1 npm run example:expo` to load the SDK, for storage editing and the State tab.

## Packages

| Package | |
|---|---|
| `capybara-devtools` | CLI: local server and UI (the command is `capybara`) |
| `@capybara-devtools/web` | Browser SDK |
| `@capybara-devtools/react-native` | React Native SDK |
| `@capybara-devtools/core` | Client runtime and built-in plugins (console, network, storage, state) |
| `@capybara-devtools/protocol` | Wire protocol types |

## Development

```bash
npm test
npm run typecheck
npm run lint
```

`npm run lint` runs [Biome](https://biomejs.dev)'s linter (formatting is left as it is); `biome.jsonc` says why the rules it turns off are off. `npm run build` and `npm run typecheck` run `tsc -b`, which only redoes the packages that changed and the ones that import them; `npm run clean` deletes the build output, as `npm run release` does first so that files of deleted sources are not published.

To work on the UI with hot reload, run the server with the Vite origin allowed, then start Vite:

```bash
npm start -- --no-open --allow-origin http://localhost:5174
npm run dev:ui
```

For a change that should go into the next release, run `npx changeset`, pick the packages and describe the change for users; commit the file it writes in `.changeset/`. All packages share one version number.

The website is in `website/`, outside the workspaces, with its own dependencies; see [website/README.md](website/README.md). Changes to it deploy to capybara-devtools.chanieshop.com when they reach `main`.

Architecture, protocol and roadmap (Vietnamese): [docs/PLAN.md](docs/PLAN.md). Releasing (Vietnamese): [docs/RELEASING.md](docs/RELEASING.md).
