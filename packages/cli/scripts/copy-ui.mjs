import { cpSync, existsSync, rmSync } from 'node:fs';

const source = new URL('../../ui/dist/', import.meta.url);
const target = new URL('../dist/ui/', import.meta.url);

if (!existsSync(source)) {
  console.warn('[capybara] UI build not found, the server will show a placeholder. Run `npm run build -w @capybara/ui` first.');
  process.exit(0);
}
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
