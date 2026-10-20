---
"capybara-devtools": patch
"@capybara-devtools/desktop": patch
"@capybara-devtools/protocol": patch
"@capybara-devtools/core": patch
---

`CAPYBARA_DEBUG=1` makes the CLI print what goes wrong while it reads React Native apps through Metro, which it otherwise gets past quietly: when it attaches to an app or leaves it to its SDK, a CDP domain the runtime does not support, logged values or response bodies it could not read, a lost connection. Limits the SDK, the Metro bridge and the server must agree on, such as the 128 KB body cap and the 10 s command timeout, now come from one place in the protocol package.
