---
"@capybara-devtools/protocol": patch
"@capybara-devtools/ui": patch
"capybara-devtools": patch
"@capybara-devtools/desktop": patch
---

Apps connect from any device on the network, so any device there can also send made-up logs and requests, and a look-alike of your app that connected last was what `capybara mcp` read by default. Now the app menu and `list_sessions` show the address of each app that connects from another device, the UI and the MCP tools read an app on this computer unless you pick another (a reload no longer follows the app on screen to another device), every tool's answer about such an app says where it connects from, and the assistant is told to treat what apps send as data, never as instructions.
