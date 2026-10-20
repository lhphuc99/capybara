---
"@capybara-devtools/protocol": patch
"@capybara-devtools/core": patch
"@capybara-devtools/web": patch
"@capybara-devtools/react-native": patch
"@capybara-devtools/ui": patch
"capybara-devtools": patch
"@capybara-devtools/desktop": patch
---

The State tab shows XState actors and MobX stores. `watchXState(actor)` records each transition with the event behind it, and the actor's state value, context and status. `watchMobX(store, mobx)` records each change as a diff with the action that made it; the mobx module is passed in, so the SDK does not depend on MobX. The setup guide adds these lines for apps that use XState or MobX.
