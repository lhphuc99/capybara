---
"@capybara-devtools/desktop": patch
"capybara-devtools": patch
---

On Linux, quitting the desktop app ends its AppImage again. The adb server it starts for `adb reverse` kept nine of the app's files open (app.asar, the .pak files), so the AppImage stayed mounted and running after the app quit. adb is now started without them; its server keeps running in the background, as it does for other Android tools.
