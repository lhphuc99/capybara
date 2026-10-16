import { existsSync } from 'node:fs';

// copy-ui.mjs only warns when the UI build is missing, so without this a publish would ship the placeholder page.
if (!existsSync(new URL('../dist/ui/index.html', import.meta.url))) {
  console.error('[capybara] dist/ui is missing. Run `npm run build` at the repo root before publishing.');
  process.exit(1);
}
