---
"@capybara-devtools/protocol": patch
"@capybara-devtools/ui": patch
"capybara-devtools": patch
"@capybara-devtools/desktop": patch
---

When Capybara starts reading a React Native app through Metro after the app has started, the Network tab and `get_network` say that requests from before then are missing and that reloading the app records them from the start. Without the SDK they cannot be recovered: the engine keeps console logs for a debugger that attaches later, but not network requests.
