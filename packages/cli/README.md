# capybara-devtools

Debug React Native and web apps from one place: logs, network (including WebSockets), storage and state (Redux, Zustand, XState, MobX, TanStack Query, SWR, React Context), streamed live to a local UI.

```bash
npx capybara-devtools
```

The UI opens at http://localhost:7357, on this computer only; apps connect from any device on your network. `--remote-ui` (or `CAPYBARA_REMOTE_UI=1`) lets other devices open the UI too.

- **React Native / Expo 0.85 or later:** start Metro and open your development app. Capybara finds it through Metro, with no SDK or code changes. Expo Go on Android is the exception: its JavaScript engine cannot be debugged, so use the SDK or a development build there.
- **Web (React, Vite, Next.js):** add [`@capybara-devtools/web`](https://www.npmjs.com/package/@capybara-devtools/web) to your app.
- **React Native below 0.85, Expo Go on Android, or to see state:** add [`@capybara-devtools/react-native`](https://www.npmjs.com/package/@capybara-devtools/react-native).
- **AI assistants:** `capybara mcp` is an MCP server that reads the same logs, requests, storage and state, for example `claude mcp add capybara -- npx capybara-devtools mcp`. Its state tools are `get_state` (the stores and their current state), `get_state_actions` (what changed and which action changed it) and `get_queries` (TanStack Query and SWR entries). When asked, the assistant can also set or remove storage keys, refetch or reset queries and clear sessions; `--read-only` leaves those tools out.
- **Setting up an app:** ask your assistant to "set up Capybara in this project". The MCP tool `get_setup_guide` tells it what to change in that app, worked out from its package.json. Without the MCP server, `npx capybara-devtools setup-guide` prints the same guide.

Update the SDK in your app along with the CLI: the State tab needs both.

Run `npx capybara-devtools --help` for the options. With `--port`, pass the same `port` to `init()` in apps that use the SDK. Requires Node 22.12 or later.

Documentation: [github.com/lhphuc99/capybara](https://github.com/lhphuc99/capybara#readme)
