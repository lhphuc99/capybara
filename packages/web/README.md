# @capybara-devtools/web

Browser SDK for [Capybara](https://github.com/lhphuc99/capybara#readme): sends your app's logs, network requests (including WebSockets), storage and state to the Capybara UI on your computer. Works with React, Vite and the client side of Next.js.

```bash
npm install @capybara-devtools/web
```

Call `init()` in a file of its own, and import that file on the first line of your entry file so early logs and requests are captured:

```ts
// capybara.ts
import { init } from '@capybara-devtools/web';

if (import.meta.env.DEV) init({ appName: 'My web app' });
```

```ts
// main.tsx
import './capybara';
import { createRoot } from 'react-dom/client';
import App from './App';
```

Called in `main.tsx` itself, `init()` would run too late: a file's imports all run before its own code, so your other modules, and the stores they create, would load first.

In Next.js 15.3 or later, put it in `instrumentation-client.ts` at the project root:

```ts
import { init } from '@capybara-devtools/web';

if (process.env.NODE_ENV === 'development') init({ appName: 'My Next.js app' });
```

Then run `npx capybara-devtools` (or open the desktop app) to see the data. If Capybara runs on another port (`--port`, or `CAPYBARA_PORT`), pass the same `port` to `init()`. `enabled: false` makes `init()` do nothing, to turn it off at run time. In a production build (`NODE_ENV=production`) `init()` does nothing, even without the `if`, unless you pass `allowProduction: true`, for example in a staging build for testers. Keep the `if` anyway: it also keeps the SDK out of the bundle.

## State

The State tab shows Redux, Zustand, TanStack Query, SWR and React Context. `init()` picks up Redux Toolkit's `configureStore()`, zustand stores made with `devtools()` and React Context providers on its own, as long as it runs before your store modules load. The rest take one line each:

```ts
import { watchQueryClient, watchSWR, watchZustand } from '@capybara-devtools/web';
import { SWRConfig } from 'swr';

if (import.meta.env.DEV) {
  watchZustand(useCounterStore, { name: 'counter' }); // a store without devtools()
  watchQueryClient(queryClient);
  watchSWR(SWRConfig); // SWR's default cache
}
```

Redux stores that `init()` cannot see take `capybaraReduxEnhancer()` or `connectReduxStore(store)`, zustand `devtools()` stores made before it take `watchZustand()`, and an `SWRConfig` with a `provider` of its own takes `use: [swrMiddleware]`. Name your zustand actions (`set(fn, false, 'cart/add')`): Vite's dependency pre-bundling keeps zustand from guessing the names, so unnamed ones show as `anonymous`. Give your contexts a `displayName` too, or they take the name of the component that renders their provider. `init({ state: false })` turns state off; [the README](https://github.com/lhphuc99/capybara#state-redux-zustand-tanstack-query-swr-react-context) has the other options and the limits.

Documentation: [github.com/lhphuc99/capybara](https://github.com/lhphuc99/capybara#web-react-vite-nextjs-client)
