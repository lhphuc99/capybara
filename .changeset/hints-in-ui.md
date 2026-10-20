---
"capybara-devtools": patch
"@capybara-devtools/desktop": patch
"@capybara-devtools/ui": patch
"@capybara-devtools/protocol": patch
---

What the CLI prints for you to act on also shows in a banner in the UI, and `capybara mcp` lists it with the apps: a device that was turned away, with how to let it in, and an app that can't be read through Metro, such as Expo Go on Android. The desktop app has no terminal, so it showed neither. The server sends them in `ServerInfo.hints`.
