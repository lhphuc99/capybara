---
"@capybara-devtools/core": patch
"@capybara-devtools/web": patch
"@capybara-devtools/react-native": patch
---

Stopping the SDK no longer removes what other tools installed after it. `stop()` put back the original `XMLHttpRequest` methods, `console` methods and AsyncStorage methods even when Sentry, Reactotron or LogBox had wrapped them since, which took their wrappers away too. It now puts back only what is still its own; a wrapper of the SDK's left under another one only passes calls on.
