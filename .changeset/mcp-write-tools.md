---
"capybara-devtools": patch
"@capybara-devtools/desktop": patch
---

`capybara mcp` can change things when you ask the assistant to: `set_storage`, `remove_storage` and `clear_storage` edit one of the app's stores, `act_on_query` refetches, invalidates, resets, cancels or removes a TanStack Query query or revalidates, clears or resets an SWR key, and `clear_session` and `remove_session` clear what Capybara recorded. They are marked as tools that change things, so clients that ask before running such tools do; `capybara mcp --read-only` leaves them out.
