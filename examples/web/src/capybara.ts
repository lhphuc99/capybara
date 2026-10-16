import { init } from '@capybara-devtools/web';

// Imported first by main.tsx so it is set up before anything else logs or fetches.
if (import.meta.env.DEV) init({ appName: 'Example web app' });
