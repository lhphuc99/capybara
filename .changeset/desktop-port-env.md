---
"@capybara-devtools/desktop": patch
---

When `CAPYBARA_PORT` is not a port, such as `abc`, the desktop app says so and offers port 7357 or to quit. It used to show a RangeError that Try Again could never get past.
