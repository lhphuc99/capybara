---
"capybara-devtools": minor
"@capybara-devtools/desktop": minor
---

Errors from React Native apps show stacks into your source files (`App.tsx:48:52`) instead of the bundle (`index.bundle…:86171:28`), through Metro and with the SDK alike, in the UI and in `capybara mcp`. Capybara asks Metro for the mapping, as LogBox does, when the bundle came from Metro on the same computer; other stacks stay as they are.
