---
"capybara-devtools": minor
"@capybara-devtools/desktop": minor
---

The UI, and what apps send to it, are now only for the computer Capybara runs on. Until now anyone on the same network could open `http://<your IP>:7357` and read everything apps send, tokens and app state included, and send commands to the apps. Apps still connect from any device. To open the UI from another device, or to point `capybara mcp --host` at this computer, start the CLI with `--remote-ui`. With `--host`, the CLI prints and opens the address it listens on instead of every LAN address, and the UI no longer offers phones an address they cannot reach.
