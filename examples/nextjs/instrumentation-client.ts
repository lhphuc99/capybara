import { init } from '@capybara-devtools/web';

// Next.js runs this file in the browser before the app's own code, so early logs and requests are kept.
if (process.env.NODE_ENV === 'development') init({ appName: 'Example Next.js app' });
