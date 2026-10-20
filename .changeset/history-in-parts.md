---
"capybara-devtools": patch
"@capybara-devtools/protocol": patch
"@capybara-devtools/ui": patch
"@capybara-devtools/desktop": patch
---

`capybara mcp` reads busy sessions again. The server sent a session's whole history in one message, and past 100 MiB, about 800 responses of 128 KB, the MCP's connection closed and every tool failed; a few times that could not even be put in one string. The UI and `capybara mcp` now ask for the history in parts of about 4 MiB, while older viewers still get one message. When an app does not answer, `capybara mcp` now says so, instead of that Capybara did not answer: it waited exactly as long as the server, and gave up first.
