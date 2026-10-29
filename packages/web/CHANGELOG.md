# @capybara-devtools/web

## 0.7.0

### Patch Changes

- Updated dependencies [d7c4f5b]
  - @capybara-devtools/protocol@0.7.0
  - @capybara-devtools/core@0.7.0

## 0.6.1

### Patch Changes

- @capybara-devtools/core@0.6.1
  - @capybara-devtools/protocol@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [44f046f]
  - @capybara-devtools/protocol@0.6.0
  - @capybara-devtools/core@0.6.0

## 0.5.1

### Patch Changes

- 86c0ffc: The Logs tab shows the other console methods the way browsers print them: entries logged inside `console.group()` are indented under the group's line, which opens and closes on a click (`console.groupCollapsed()` starts closed), `console.table()` shows a table, `console.trace()` the stack it was called from, and `console.count()`, `console.time()`/`timeLog()`/`timeEnd()` and a failed `console.assert()` the line the browser prints. This works through Metro too, where a trace starts at the app's call as LogBox shows it, without the console wrappers of React Native and React DevTools, and `capybara mcp` indents grouped entries. In React Native apps with the SDK, an unhandled promise rejection is now marked as one, as it already was through Metro.
- 4c5dcdd: Events from a web app whose tab is in the background reach Capybara right away. The SDK sent them on a 50 ms timer, which browsers run at most once a second in a hidden tab (Chrome once a minute after a while), so with the app in one tab and Capybara in another, logs, requests and storage changes came in bursts. While the page is hidden, the SDK now sends at the end of the task that recorded them.
- 97535b1: In the Network tab, **Headers & bodies** makes the filter match headers, bodies and WebSocket messages too, and **Pause** keeps the list still while new requests are counted for **Resume**. A response whose body is still arriving after half a second, such as a streamed AI answer or a long poll, shows its status and headers as `streaming` instead of staying pending; with `fetch`, its Response tab shows what has come so far. `get_network` in `capybara mcp` takes `inContent` for the same search. A search such as `/api/users` is now taken as text rather than as a regular expression with invalid flags.
- 2427732: A reused `XMLHttpRequest` is recorded right. When an app opened the same XHR again for the next request, the earlier request's listeners stayed on it, so the earlier request also got the later one's response. Each request now ends with its own result: one cut off by opening the XHR again while it was on its way shows as aborted, and one opened again from its `onload` is recorded before the `loadend` the browser still sends for it.
- 86c0ffc: `init({ state: { sanitizeEntry(data, { store, key }) } })` runs before the data of a TanStack Query or SWR entry leaves the app, as `sanitizeState` does for other stores, e.g. to blank out tokens.
- 86c0ffc: The State tab shows XState actors and MobX stores. `watchXState(actor)` records each transition with the event behind it, and the actor's state value, context and status. `watchMobX(store, mobx)` records each change as a diff with the action that made it; the mobx module is passed in, so the SDK does not depend on MobX. The setup guide adds these lines for apps that use XState or MobX.
- 0fbe91d: Stopping the SDK no longer removes what other tools installed after it. `stop()` put back the original `XMLHttpRequest` methods, `console` methods and AsyncStorage methods even when Sentry, Reactotron or LogBox had wrapped them since, which took their wrappers away too. It now puts back only what is still its own; a wrapper of the SDK's left under another one only passes calls on.
- Updated dependencies [ab2f49e]
- Updated dependencies [b08c751]
- Updated dependencies [86c0ffc]
- Updated dependencies [ea11af6]
- Updated dependencies [4c5dcdd]
- Updated dependencies [6eb376c]
- Updated dependencies [5394dda]
- Updated dependencies [1ec7ad5]
- Updated dependencies [97535b1]
- Updated dependencies [2427732]
- Updated dependencies [86c0ffc]
- Updated dependencies [39a9f21]
- Updated dependencies [86c0ffc]
- Updated dependencies [0fbe91d]
  - @capybara-devtools/protocol@0.5.1
  - @capybara-devtools/core@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies [69ff11d]
- Updated dependencies [b38c5a1]
  - @capybara-devtools/core@0.5.0
  - @capybara-devtools/protocol@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [c1b095e]
  - @capybara-devtools/core@0.4.0
  - @capybara-devtools/protocol@0.4.0

## 0.3.1

### Patch Changes

- 432e433: `init()` now does nothing in a production build (`NODE_ENV=production` on the web, `__DEV__` false in React Native), even when the call is not wrapped in a dev check, so a forgotten check no longer runs the SDK for an app's users: no patched console or network, no connection attempts, no Redux DevTools stand-in. Pass `allowProduction: true` to run it in such a build on purpose, for example a staging build for testers. Keep the dev check anyway: on the web it also keeps the SDK out of the bundle.
- @capybara-devtools/core@0.3.1
  - @capybara-devtools/protocol@0.3.1

## 0.3.0

### Minor Changes

- 8c9ae31: Add a State tab for Redux, Zustand, TanStack Query, SWR and React Context, for apps with the web or React Native SDK. Redux, Zustand and Context stores show a timeline of changes with their diffs, and the current state; Redux stores and zustand's `devtools()` stores also name the action behind each change. TanStack Query and SWR show their entries by status, with their data and buttons to refetch, invalidate, reset, cancel or remove a query and to revalidate, clear or reset an SWR key. `init()` picks up Redux Toolkit's `configureStore()`, zustand stores made with `devtools()` and React Context providers on its own, as long as it runs before your store modules load. The rest take one line each: `watchZustand(store)`, `watchQueryClient(queryClient)`, `watchSWR(SWRConfig)`, or `swrMiddleware` for an `SWRConfig` with its own provider; `capybaraReduxEnhancer()` covers Redux stores the SDK cannot see. `init({ state: false })` turns state off. `capybara mcp` has three new read-only tools, `get_state`, `get_state_actions` and `get_queries`, and hides more credentials: keys named like `jwt`, `bearer` or `privateKey`, and JWTs, bearer tokens and Stripe, GitHub, Slack and AWS keys in the keys and errors of queries and SWR entries. Update the CLI or the desktop app together with the SDK: an older one keeps state events in the same history as logs, which can push logs out.

### Patch Changes

- Updated dependencies [8c9ae31]
  - @capybara-devtools/protocol@0.3.0
  - @capybara-devtools/core@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies
  - @capybara-devtools/core@0.2.1
  - @capybara-devtools/protocol@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies [4e64ddc]
  - @capybara-devtools/protocol@0.2.0
  - @capybara-devtools/core@0.2.0
