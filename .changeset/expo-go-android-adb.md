---
"capybara-devtools": patch
"@capybara-devtools/desktop": patch
---

Expo Go on Android no longer shows up through Metro as an empty "Expo Go" session, which also duplicated apps that have the SDK and was the one picked by default. Its JavaScript engine cannot be debugged, so Capybara reads such apps only through the SDK, and the CLI says so once, suggesting the SDK or a development build. `adb reverse` is set up again when an Android device reconnects (`adb reconnect`, an emulator restart), so the SDK reaches Capybara over USB again. `capybara mcp` shows credential-named values that are empty (`null`, `undefined`, `false`, `''`) instead of hiding them, so a signed-out app reads differently from a signed-in one.
