---
"@capybara-devtools/ui": patch
"capybara-devtools": patch
"@capybara-devtools/desktop": patch
---

The UI says when something it asked for did not happen. Clear and Remove while the Capybara server is offline used to do nothing; a toast now says to try again once it reconnects. In the State tab, an app that did not list its stores or its queries and SWR keys, for example because it did not answer in time, now gets a message instead of an empty or out-of-date list, or a setup guide for stores it already has.
