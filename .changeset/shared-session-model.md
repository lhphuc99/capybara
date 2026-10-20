---
"@capybara-devtools/protocol": patch
"capybara-devtools": patch
"@capybara-devtools/ui": patch
"@capybara-devtools/desktop": patch
---

The UI and `capybara mcp` rebuild logs, requests, WebSockets and state stores from a session's events with the same code, now in the protocol package (`applySessionEvents`, `applyStateEvent`, `currentStores`), instead of two copies that had to follow each other. One difference this removes: `capybara mcp` now says why a WebSocket failed, such as "Closed with code 1006", as the UI does.
