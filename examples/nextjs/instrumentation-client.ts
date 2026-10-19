import { init, watchSWR } from '@capybara-devtools/web';
import { SWRConfig } from 'swr';

// Next.js runs this file in the browser before the app's own code, so early logs and requests are kept.
if (process.env.NODE_ENV === 'development') {
  init({ appName: 'Example Next.js app' });
  // SWR's default cache. The SWRConfig in app/providers.tsx keeps it, since it gives no provider of its own.
  watchSWR(SWRConfig);
}
