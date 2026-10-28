# @capybara-devtools/protocol

## 0.6.1

No changes in this release.

## 0.6.0

### Minor Changes

- 44f046f: Flutter apps show up without a package. Capybara reads apps that `flutter run` or an IDE started in debug mode through the Dart VM service, as Flutter DevTools does: `print`, `debugPrint` and `developer.log` output (with what was logged before Capybara attached), Flutter errors with their stack, and HTTP requests with their bodies, from `package:http`, dio, `HttpClient`, `Image.network`, cupertino_http and cronet_http. It finds them on its own; one it did not find can be given by the address `flutter run` prints, with `--flutter-vm-service <address>` or in the UI (**Connect a Flutter app…** in the top bar or the app menu, and the Flutter tab of the start page, which now has a tab per platform), and `--no-flutter` (or Settings in the desktop app) turns it off. Dart stacks show the app's own frames, with Flutter's and the Dart SDK's folded into a line per package. It only reads, and switches on dart:io's HTTP profiling, which it switches off again when done. `capybara setup-guide` and the MCP server's `get_setup_guide` recognise Flutter apps by their pubspec.yaml, and `get_logs` lists the app's own frames of a Dart stack first.
  
  The Capybara package for Flutter, `capybara_devtools` on pub.dev with `capybara_devtools_riverpod` and `capybara_devtools_bloc`, adds storage, state and WebSocket messages, and Capybara speaks to it: the State tab groups Riverpod, Bloc and watched notifiers, a store can be marked secret (secure storage), whose values `capybara mcp` hides, the State and Storage tabs show Dart code for apps with the package, the update notice says `flutter pub add`, `setup-guide` lists the package's steps from the app's dependencies, and an app running the package that cannot reach Capybara, as an iPhone, is told its address through the VM service.

## 0.5.1

### Patch Changes

- ab2f49e: Apps connect from any device on the network, so any device there can also send made-up logs and requests, and a look-alike of your app that connected last was what `capybara mcp` read by default. Now the app menu and `list_sessions` show the address of each app that connects from another device, the UI and the MCP tools read an app on this computer unless you pick another (a reload no longer follows the app on screen to another device), every tool's answer about such an app says where it connects from, and the assistant is told to treat what apps send as data, never as instructions.
- b08c751: `CAPYBARA_DEBUG=1` makes the CLI print what goes wrong while it reads React Native apps through Metro, which it otherwise gets past quietly: when it attaches to an app or leaves it to its SDK, a CDP domain the runtime does not support, logged values or response bodies it could not read, a lost connection. Limits the SDK, the Metro bridge and the server must agree on, such as the 128 KB body cap and the 10 s command timeout, now come from one place in the protocol package.
- 86c0ffc: The Logs tab shows the other console methods the way browsers print them: entries logged inside `console.group()` are indented under the group's line, which opens and closes on a click (`console.groupCollapsed()` starts closed), `console.table()` shows a table, `console.trace()` the stack it was called from, and `console.count()`, `console.time()`/`timeLog()`/`timeEnd()` and a failed `console.assert()` the line the browser prints. This works through Metro too, where a trace starts at the app's call as LogBox shows it, without the console wrappers of React Native and React DevTools, and `capybara mcp` indents grouped entries. In React Native apps with the SDK, an unhandled promise rejection is now marked as one, as it already was through Metro.
- ea11af6: An error logged without a message, such as `new Error()`, now shows the top of its stack in the log list of `capybara mcp`, and copying it no longer writes its name twice.
- 6eb376c: What the CLI prints for you to act on also shows in a banner in the UI, and `capybara mcp` lists it with the apps: a device that was turned away, with how to let it in, and an app that can't be read through Metro, such as Expo Go on Android. The desktop app has no terminal, so it showed neither. The server sends them in `ServerInfo.hints`.
- 5394dda: `capybara mcp` reads busy sessions again. The server sent a session's whole history in one message, and past 100 MiB, about 800 responses of 128 KB, the MCP's connection closed and every tool failed; a few times that could not even be put in one string. The UI and `capybara mcp` now ask for the history in parts of about 4 MiB, while older viewers still get one message. When an app does not answer, `capybara mcp` now says so, instead of that Capybara did not answer: it waited exactly as long as the server, and gave up first.
- 1ec7ad5: When Capybara starts reading a React Native app through Metro after the app has started, the Network tab and `get_network` say that requests from before then are missing and that reloading the app records them from the start. Without the SDK they cannot be recovered: the engine keeps console logs for a debugger that attaches later, but not network requests.
- 97535b1: In the Network tab, **Headers & bodies** makes the filter match headers, bodies and WebSocket messages too, and **Pause** keeps the list still while new requests are counted for **Resume**. A response whose body is still arriving after half a second, such as a streamed AI answer or a long poll, shows its status and headers as `streaming` instead of staying pending; with `fetch`, its Response tab shows what has come so far. `get_network` in `capybara mcp` takes `inContent` for the same search. A search such as `/api/users` is now taken as text rather than as a regular expression with invalid flags.
- 39a9f21: The UI and `capybara mcp` rebuild logs, requests, WebSockets and state stores from a session's events with the same code, now in the protocol package (`applySessionEvents`, `applyStateEvent`, `currentStores`), instead of two copies that had to follow each other. One difference this removes: `capybara mcp` now says why a WebSocket failed, such as "Closed with code 1006", as the UI does.
- 86c0ffc: The State tab shows XState actors and MobX stores. `watchXState(actor)` records each transition with the event behind it, and the actor's state value, context and status. `watchMobX(store, mobx)` records each change as a diff with the action that made it; the mobx module is passed in, so the SDK does not depend on MobX. The setup guide adds these lines for apps that use XState or MobX.

## 0.5.0

### Minor Changes

- b38c5a1: The UI, and what apps send to it, are now only for the computer Capybara runs on. Until now anyone on the same network could open `http://<your IP>:7357` and read everything apps send, tokens and app state included, and send commands to the apps. Apps still connect from any device. To open the UI from another device, or to point `capybara mcp --host` at this computer, start the CLI with `--remote-ui` or set `CAPYBARA_REMOTE_UI=1`, which the desktop app reads too. The UI's device button shows the address to copy and a QR code to scan with a phone or tablet, or how to turn it on. The CLI's startup message says so too, as Vite does for `--host`; a device that is turned away gets a page that says how to let it in, the CLI prints its address once, and `capybara mcp --host` says Capybara refused it instead of that Capybara is not running. With `--host`, the CLI prints and opens the address it listens on instead of every LAN address, and the UI no longer offers phones an address they cannot reach.

## 0.4.0

No changes in this release.

## 0.3.1

No changes in this release.

## 0.3.0

### Minor Changes

- 8c9ae31: Add a State tab for Redux, Zustand, TanStack Query, SWR and React Context, for apps with the web or React Native SDK. Redux, Zustand and Context stores show a timeline of changes with their diffs, and the current state; Redux stores and zustand's `devtools()` stores also name the action behind each change. TanStack Query and SWR show their entries by status, with their data and buttons to refetch, invalidate, reset, cancel or remove a query and to revalidate, clear or reset an SWR key. `init()` picks up Redux Toolkit's `configureStore()`, zustand stores made with `devtools()` and React Context providers on its own, as long as it runs before your store modules load. The rest take one line each: `watchZustand(store)`, `watchQueryClient(queryClient)`, `watchSWR(SWRConfig)`, or `swrMiddleware` for an `SWRConfig` with its own provider; `capybaraReduxEnhancer()` covers Redux stores the SDK cannot see. `init({ state: false })` turns state off. `capybara mcp` has three new read-only tools, `get_state`, `get_state_actions` and `get_queries`, and hides more credentials: keys named like `jwt`, `bearer` or `privateKey`, and JWTs, bearer tokens and Stripe, GitHub, Slack and AWS keys in the keys and errors of queries and SWR entries. Update the CLI or the desktop app together with the SDK: an older one keeps state events in the same history as logs, which can push logs out.

## 0.2.1

No changes in this release.

## 0.2.0

### Minor Changes

- 4e64ddc: Say when a newer Capybara is out. `npx capybara-devtools` prints a line when npm has a newer version, and the UI shows a notice with the install command when a connected app uses an older SDK. The desktop app asks before updating: the Windows installer and the AppImage download the update and restart into it, other builds open the release page. `--no-update-check` or `CAPYBARA_NO_UPDATE_CHECK=1` turns the checks off.
