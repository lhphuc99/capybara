---
"@capybara-devtools/protocol": patch
"@capybara-devtools/core": patch
"@capybara-devtools/web": patch
"@capybara-devtools/react-native": patch
"@capybara-devtools/ui": patch
"capybara-devtools": patch
"@capybara-devtools/desktop": patch
---

In the Network tab, **Headers & bodies** makes the filter match headers, bodies and WebSocket messages too, and **Pause** keeps the list still while new requests are counted for **Resume**. A response whose body is still arriving after half a second, such as a streamed AI answer or a long poll, shows its status and headers as `streaming` instead of staying pending; with `fetch`, its Response tab shows what has come so far. `get_network` in `capybara mcp` takes `inContent` for the same search. A search such as `/api/users` is now taken as text rather than as a regular expression with invalid flags.
