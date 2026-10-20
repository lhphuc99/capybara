---
"capybara-devtools": patch
"@capybara-devtools/ui": patch
"@capybara-devtools/desktop": patch
---

Storage read through Metro can be edited too: in a React Native app without the SDK, the Storage tab (and `set_storage`, `remove_storage` and `clear_storage` in `capybara mcp`) sets, removes and clears keys of the AsyncStorage and MMKV instances Capybara found, through their own `setItem`/`removeItem`/`clear` and `set`/`remove`/`clearAll`. A value set in MMKV this way is saved as text. The SDK is still what makes the tab update as the app writes.
