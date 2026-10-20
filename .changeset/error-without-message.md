---
"@capybara-devtools/protocol": patch
"@capybara-devtools/ui": patch
"capybara-devtools": patch
"@capybara-devtools/desktop": patch
---

An error logged without a message, such as `new Error()`, now shows the top of its stack in the log list of `capybara mcp`, and copying it no longer writes its name twice.
