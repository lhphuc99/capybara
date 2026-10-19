# @capybara-devtools/desktop

## 0.5.0

### Minor Changes

- 1284b47: Errors from React Native apps show stacks into your source files (`App.tsx:48:52`) instead of the bundle (`index.bundle…:86171:28`), through Metro and with the SDK alike, in the UI and in `capybara mcp`. Capybara asks Metro for the mapping, as LogBox does, when the bundle came from Metro on the same computer; other stacks stay as they are.
- b38c5a1: The UI, and what apps send to it, are now only for the computer Capybara runs on. Until now anyone on the same network could open `http://<your IP>:7357` and read everything apps send, tokens and app state included, and send commands to the apps. Apps still connect from any device. To open the UI from another device, or to point `capybara mcp --host` at this computer, start the CLI with `--remote-ui` or set `CAPYBARA_REMOTE_UI=1`, which the desktop app reads too. The UI's device button shows the address to copy and a QR code to scan with a phone or tablet, or how to turn it on. The CLI's startup message says so too, as Vite does for `--host`; a device that is turned away gets a page that says how to let it in, the CLI prints its address once, and `capybara mcp --host` says Capybara refused it instead of that Capybara is not running. With `--host`, the CLI prints and opens the address it listens on instead of every LAN address, and the UI no longer offers phones an address they cannot reach.

### Patch Changes

- 7c8b307: On Linux, quitting the desktop app ends its AppImage again. The adb server it starts for `adb reverse` kept nine of the app's files open (app.asar, the .pak files), so the AppImage stayed mounted and running after the app quit. adb is now started without them; its server keeps running in the background, as it does for other Android tools.
- 69ff11d: The Network tab's Fetch and XHR filters are one Fetch/XHR filter, as in Chrome's DevTools, and it includes requests whose kind is unknown. The Fetch filter showed nothing for most React Native apps: React Native's `fetch` runs on XHR, and through Metro, Expo Go reports every request without saying whether `fetch` or XHR made it. The Type column is more exact where that can be told: with the SDK in bare React Native, a `fetch` is recorded once, as fetch rather than XHR, and through Metro, React Native's own network reporting is told apart by the JavaScript stack it sends.
- 91f6e20: On narrow windows and phones the top bar fits again: the app picker no longer covers the tabs, and the app, appearance and device menus are no longer cut off. Below 860 pixels the bar shows the logo without the name, below 720 the tabs get a row of their own, and below 480 the connection status is a dot whose label shows on hover.
- 462dfd5: More of the UI can be resized, so long URLs, keys and store names show in full: drag the line between the Path and Host columns in the Network tab, between the keys and values in the Storage tab, or beside the list of stores in the Storage and State tabs. Double-click a line to reset it; widths are remembered. The Type column fits `websocket` without cutting it.

## 0.4.0

No changes in this release.

## 0.3.1

No changes in this release.

## 0.3.0

### Minor Changes

- 8c9ae31: Add a State tab for Redux, Zustand, TanStack Query, SWR and React Context, for apps with the web or React Native SDK. Redux, Zustand and Context stores show a timeline of changes with their diffs, and the current state; Redux stores and zustand's `devtools()` stores also name the action behind each change. TanStack Query and SWR show their entries by status, with their data and buttons to refetch, invalidate, reset, cancel or remove a query and to revalidate, clear or reset an SWR key. `init()` picks up Redux Toolkit's `configureStore()`, zustand stores made with `devtools()` and React Context providers on its own, as long as it runs before your store modules load. The rest take one line each: `watchZustand(store)`, `watchQueryClient(queryClient)`, `watchSWR(SWRConfig)`, or `swrMiddleware` for an `SWRConfig` with its own provider; `capybaraReduxEnhancer()` covers Redux stores the SDK cannot see. `init({ state: false })` turns state off. `capybara mcp` has three new read-only tools, `get_state`, `get_state_actions` and `get_queries`, and hides more credentials: keys named like `jwt`, `bearer` or `privateKey`, and JWTs, bearer tokens and Stripe, GitHub, Slack and AWS keys in the keys and errors of queries and SWR entries. Update the CLI or the desktop app together with the SDK: an older one keeps state events in the same history as logs, which can push logs out.

### Patch Changes

- d3c4672: Expo Go on Android no longer shows up through Metro as an empty "Expo Go" session, which also duplicated apps that have the SDK and was the one picked by default. Its JavaScript engine cannot be debugged, so Capybara reads such apps only through the SDK, and the CLI says so once, suggesting the SDK or a development build. `adb reverse` is set up again when an Android device reconnects (`adb reconnect`, an emulator restart), so the SDK reaches Capybara over USB again. `capybara mcp` shows credential-named values that are empty (`null`, `undefined`, `false`, `''`) instead of hiding them, so a signed-out app reads differently from a signed-in one.

## 0.2.1

No changes in this release.

## 0.2.0

### Minor Changes

- 4e64ddc: Say when a newer Capybara is out. `npx capybara-devtools` prints a line when npm has a newer version, and the UI shows a notice with the install command when a connected app uses an older SDK. The desktop app asks before updating: the Windows installer and the AppImage download the update and restart into it, other builds open the release page. `--no-update-check` or `CAPYBARA_NO_UPDATE_CHECK=1` turns the checks off.
