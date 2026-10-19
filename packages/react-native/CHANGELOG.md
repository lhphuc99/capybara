# @capybara-devtools/react-native

## 0.4.0

### Patch Changes

- c1b095e: React Native apps on Expo Router 58 no longer show about 25 of Expo Router's and React Navigation's own contexts as the app's, in the State tab and in `get_state`. Capybara now knows Expo Router 58's providers, including its nameless `Stack`, React Navigation's named contexts and its theme, so with Expo Router's Stack, Tabs and NativeTabs only the app's own contexts are listed; the others are under **Show library contexts**.
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
