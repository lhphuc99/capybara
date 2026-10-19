# @capybara-devtools/core

## 0.3.0

### Minor Changes

- 8c9ae31: Add a State tab for Redux, Zustand, TanStack Query, SWR and React Context, for apps with the web or React Native SDK. Redux, Zustand and Context stores show a timeline of changes with their diffs, and the current state; Redux stores and zustand's `devtools()` stores also name the action behind each change. TanStack Query and SWR show their entries by status, with their data and buttons to refetch, invalidate, reset, cancel or remove a query and to revalidate, clear or reset an SWR key. `init()` picks up Redux Toolkit's `configureStore()`, zustand stores made with `devtools()` and React Context providers on its own, as long as it runs before your store modules load. The rest take one line each: `watchZustand(store)`, `watchQueryClient(queryClient)`, `watchSWR(SWRConfig)`, or `swrMiddleware` for an `SWRConfig` with its own provider; `capybaraReduxEnhancer()` covers Redux stores the SDK cannot see. `init({ state: false })` turns state off. `capybara mcp` has three new read-only tools, `get_state`, `get_state_actions` and `get_queries`, and hides more credentials: keys named like `jwt`, `bearer` or `privateKey`, and JWTs, bearer tokens and Stripe, GitHub, Slack and AWS keys in the keys and errors of queries and SWR entries. Update the CLI or the desktop app together with the SDK: an older one keeps state events in the same history as logs, which can push logs out.

### Patch Changes

- Updated dependencies [8c9ae31]
  - @capybara-devtools/protocol@0.3.0

## 0.2.1

### Patch Changes

- Same contents as 0.2.0, published again because npm took several minutes to make `@capybara-devtools/core` 0.2.0 available, and the 0.2.0 CLI and SDKs depend on it.
- @capybara-devtools/protocol@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies [4e64ddc]
  - @capybara-devtools/protocol@0.2.0
