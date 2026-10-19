---
"capybara-devtools": minor
---

`capybara mcp` can now set Capybara up in an app: ask the assistant to "set up Capybara in this project", or use the server's `setup` prompt (`/mcp__capybara__setup` in Claude Code). The new tool `get_setup_guide` reads the app's package.json and lockfile and says what to change in that app: the SDK to install with its package manager, the file that calls `init()` and where to import it (`instrumentation-client.ts` in Next.js 15.3 and later, an entry file of its own with Expo Router), and the line each state library needs. It changes no file and works before Capybara runs; at a monorepo's root it lists the apps. `capybara setup-guide [folder]` prints the same guide for assistants without the MCP server.
