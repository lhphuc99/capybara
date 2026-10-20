---
"capybara-devtools": patch
"@capybara-devtools/desktop": patch
---

Stack traces from web apps point into their source files, as React Native stacks already did: the server maps the frames of logged errors, uncaught errors and `console.trace()` through the source maps the dev server serves with each script (checked with Vite and with Next.js on Turbopack). Only scripts of the page's own dev server on this computer are fetched, and maps on that same server.
