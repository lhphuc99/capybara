# @capybara-devtools/web

Browser SDK for [Capybara](https://github.com/lhphuc99/capybara#readme): sends your app's logs, network requests (including WebSockets) and storage to the Capybara UI on your computer. Works with React, Vite and the client side of Next.js.

```bash
npm install @capybara-devtools/web
```

Import it before the rest of your app so early logs and requests are captured:

```ts
import { init } from '@capybara-devtools/web';

if (import.meta.env.DEV) init({ appName: 'My web app' });
```

In Next.js 15.3 or later, put it in `instrumentation-client.ts` at the project root:

```ts
import { init } from '@capybara-devtools/web';

if (process.env.NODE_ENV === 'development') init({ appName: 'My Next.js app' });
```

Then run `npx capybara-devtools` (or open the desktop app) to see the data.

Documentation: [github.com/lhphuc99/capybara](https://github.com/lhphuc99/capybara#web-react-vite-nextjs-client)
