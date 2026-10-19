---
"capybara-devtools": patch
"@capybara-devtools/ui": patch
"@capybara-devtools/desktop": patch
"@capybara-devtools/core": patch
"@capybara-devtools/react-native": patch
---

The Network tab's Fetch and XHR filters are one Fetch/XHR filter, as in Chrome's DevTools, and it includes requests whose kind is unknown. The Fetch filter showed nothing for most React Native apps: React Native's `fetch` runs on XHR, and through Metro, Expo Go reports every request without saying whether `fetch` or XHR made it. The Type column is more exact where that can be told: with the SDK in bare React Native, a `fetch` is recorded once, as fetch rather than XHR, and through Metro, React Native's own network reporting is told apart by the JavaScript stack it sends.
