---
"capybara-devtools": patch
"@capybara-devtools/desktop": patch
---

`npx capybara-devtools` started while Capybara already runs on the port, such as the desktop app, opens that one's UI and exits, instead of failing with "Port 7357 is already in use". Like the desktop app, it now also notices a program that holds the port on localhost only, which macOS would otherwise let it share while apps on this computer kept reaching that program. An empty `CAPYBARA_PORT` means the default port, as in the desktop app, not any free port; the CLI, `capybara mcp` and the desktop app read it, `CAPYBARA_REMOTE_UI` and `CAPYBARA_NO_UPDATE_CHECK` the same way.
