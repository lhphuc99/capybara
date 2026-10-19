---
"@capybara-devtools/core": patch
"@capybara-devtools/react-native": patch
---

React Native apps on Expo Router 58 no longer show about 25 of Expo Router's and React Navigation's own contexts as the app's, in the State tab and in `get_state`. Capybara now knows Expo Router 58's providers, including its nameless `Stack`, React Navigation's named contexts and its theme, so with Expo Router's Stack, Tabs and NativeTabs only the app's own contexts are listed; the others are under **Show library contexts**.
