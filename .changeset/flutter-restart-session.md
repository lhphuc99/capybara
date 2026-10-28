---
"capybara-devtools": patch
"@capybara-devtools/desktop": patch
---

A Flutter app read through the Dart VM service no longer leaves a second session that shows as connected when it hot restarts while Capybara is still setting it up. That session got nothing more and stayed until Capybara quit.
