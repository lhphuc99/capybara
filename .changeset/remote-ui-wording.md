---
"capybara-devtools": patch
"@capybara-devtools/desktop": patch
---

With `--remote-ui`, the CLI's banner says under the Network address that anyone on the network can open the UI and see everything apps send, tokens included. A browser that asks for Capybara by a name, such as this computer's `.local` name, gets a page saying to open it at localhost or an IP address instead of a bare "Forbidden host".
