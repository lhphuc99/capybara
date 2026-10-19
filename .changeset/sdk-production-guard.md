---
"@capybara-devtools/web": patch
"@capybara-devtools/react-native": patch
---

`init()` now does nothing in a production build (`NODE_ENV=production` on the web, `__DEV__` false in React Native), even when the call is not wrapped in a dev check, so a forgotten check no longer runs the SDK for an app's users: no patched console or network, no connection attempts, no Redux DevTools stand-in. Pass `allowProduction: true` to run it in such a build on purpose, for example a staging build for testers. Keep the dev check anyway: on the web it also keeps the SDK out of the bundle.
