---
"capybara-devtools": patch
"@capybara-devtools/desktop": patch
---

The desktop app has a **Settings** menu (in the Capybara menu on macOS, the File menu elsewhere): **Let Other Devices Open the UI**, which asks first and lets go of other devices again when turned off, reading React Native apps through Metro on or off, and the Metro ports to look on. It remembers them between launches. The server can now turn remote UI on and off while it runs (`setRemoteUi`), and a device that is turned away is told about the menu instead of `CAPYBARA_REMOTE_UI`.
