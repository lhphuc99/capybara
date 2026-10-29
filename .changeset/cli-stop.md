---
"capybara-devtools": minor
"@capybara-devtools/protocol": minor
---

`npx capybara-devtools stop` stops the Capybara server running on this computer, as Ctrl+C in its terminal would, including one an AI assistant started in the background, which has no terminal to press Ctrl+C in. `--port` (or `$CAPYBARA_PORT`) and `--host` pick the server, and the CLI prints the command with them when it starts, and when it finds Capybara already running. The desktop app is not stopped this way: quit it from its menu. Servers from earlier versions cannot be asked to stop, so for those the command says how else to stop them.
