# capybara-devtools

## 0.3.0

### Minor Changes

- 8c9ae31: Add a State tab for Redux, Zustand, TanStack Query, SWR and React Context, for apps with the web or React Native SDK. Redux, Zustand and Context stores show a timeline of changes with their diffs, and the current state; Redux stores and zustand's `devtools()` stores also name the action behind each change. TanStack Query and SWR show their entries by status, with their data and buttons to refetch, invalidate, reset, cancel or remove a query and to revalidate, clear or reset an SWR key. `init()` picks up Redux Toolkit's `configureStore()`, zustand stores made with `devtools()` and React Context providers on its own, as long as it runs before your store modules load. The rest take one line each: `watchZustand(store)`, `watchQueryClient(queryClient)`, `watchSWR(SWRConfig)`, or `swrMiddleware` for an `SWRConfig` with its own provider; `capybaraReduxEnhancer()` covers Redux stores the SDK cannot see. `init({ state: false })` turns state off. `capybara mcp` has three new read-only tools, `get_state`, `get_state_actions` and `get_queries`, and hides more credentials: keys named like `jwt`, `bearer` or `privateKey`, and JWTs, bearer tokens and Stripe, GitHub, Slack and AWS keys in the keys and errors of queries and SWR entries. Update the CLI or the desktop app together with the SDK: an older one keeps state events in the same history as logs, which can push logs out.

### Patch Changes

- d3c4672: Expo Go on Android no longer shows up through Metro as an empty "Expo Go" session, which also duplicated apps that have the SDK and was the one picked by default. Its JavaScript engine cannot be debugged, so Capybara reads such apps only through the SDK, and the CLI says so once, suggesting the SDK or a development build. `adb reverse` is set up again when an Android device reconnects (`adb reconnect`, an emulator restart), so the SDK reaches Capybara over USB again. `capybara mcp` shows credential-named values that are empty (`null`, `undefined`, `false`, `''`) instead of hiding them, so a signed-out app reads differently from a signed-in one.
- Updated dependencies [8c9ae31]
  - @capybara-devtools/protocol@0.3.0
  - @capybara-devtools/core@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies
  - @capybara-devtools/core@0.2.1
  - @capybara-devtools/protocol@0.2.1

## 0.2.0

### Minor Changes

- 4e64ddc: Say when a newer Capybara is out. `npx capybara-devtools` prints a line when npm has a newer version, and the UI shows a notice with the install command when a connected app uses an older SDK. The desktop app asks before updating: the Windows installer and the AppImage download the update and restart into it, other builds open the release page. `--no-update-check` or `CAPYBARA_NO_UPDATE_CHECK=1` turns the checks off.

### Patch Changes

- Updated dependencies [4e64ddc]
  - @capybara-devtools/protocol@0.2.0
  - @capybara-devtools/core@0.2.0
