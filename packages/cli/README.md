# capybara-devtools

Debug React Native and web apps from one place: logs, network (including WebSockets) and storage, streamed live to a local UI.

```bash
npx capybara-devtools
```

The UI opens at http://localhost:7357.

- **React Native / Expo 0.85 or later:** start Metro and open your development app. Capybara finds it through Metro, with no SDK or code changes.
- **Web (React, Vite, Next.js):** add [`@capybara-devtools/web`](https://www.npmjs.com/package/@capybara-devtools/web) to your app.
- **React Native below 0.85, or to edit storage:** add [`@capybara-devtools/react-native`](https://www.npmjs.com/package/@capybara-devtools/react-native).
- **AI assistants:** `capybara mcp` is an MCP server that reads the same logs, requests and storage, for example `claude mcp add capybara -- npx capybara-devtools mcp`.

Run `npx capybara-devtools --help` for the options. Requires Node 20.19 or later.

Documentation: [github.com/lhphuc99/capybara](https://github.com/lhphuc99/capybara#readme)
