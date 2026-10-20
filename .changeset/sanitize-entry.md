---
"@capybara-devtools/core": patch
"@capybara-devtools/web": patch
"@capybara-devtools/react-native": patch
---

`init({ state: { sanitizeEntry(data, { store, key }) } })` runs before the data of a TanStack Query or SWR entry leaves the app, as `sanitizeState` does for other stores, e.g. to blank out tokens.
