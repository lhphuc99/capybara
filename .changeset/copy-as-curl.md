---
"@capybara-devtools/ui": patch
"capybara-devtools": patch
"@capybara-devtools/desktop": patch
---

Copy cURL makes commands that send what the app sent. A HEAD request used `-X HEAD`, which leaves curl waiting for a body; it now uses `--head`. Form data was left out; its fields are now sent with `--form-string` and its files with `-F`, by file name from the current folder. When the command cannot send the body as the app did, because the SDK cut it or did not capture it as text, the toast says so.
