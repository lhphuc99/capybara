---
"capybara-devtools": minor
"@capybara-devtools/desktop": minor
"@capybara-devtools/ui": minor
"@capybara-devtools/protocol": minor
---

The UI, and what apps send to it, are now only for the computer Capybara runs on. Until now anyone on the same network could open `http://<your IP>:7357` and read everything apps send, tokens and app state included, and send commands to the apps. Apps still connect from any device. To open the UI from another device, or to point `capybara mcp --host` at this computer, start the CLI with `--remote-ui` or set `CAPYBARA_REMOTE_UI=1`, which the desktop app reads too. The UI's device button shows the address to copy and a QR code to scan with a phone or tablet, or how to turn it on. The CLI's startup message says so too, as Vite does for `--host`; a device that is turned away gets a page that says how to let it in, the CLI prints its address once, and `capybara mcp --host` says Capybara refused it instead of that Capybara is not running. With `--host`, the CLI prints and opens the address it listens on instead of every LAN address, and the UI no longer offers phones an address they cannot reach.
