---
"@capybara-devtools/ui": patch
"capybara-devtools": patch
"@capybara-devtools/desktop": patch
---

The Storage tab keeps up with an app that writes all the time. It waited for 250 ms without a write before reading the storage again, so a persisted store written several times a second showed old values until the app stopped writing. It now reads again at most every 250 ms while the writes go on, shows a slow reply unless a newer one is already shown, and Refresh reads at once.
