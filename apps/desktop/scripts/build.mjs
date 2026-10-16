import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'rolldown';

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const dist = path('../dist/');
const ui = path('../../../packages/ui/dist/');

for (const required of [path('../../../packages/cli/dist/server.js'), ui]) {
  if (!existsSync(required)) {
    console.error(`[desktop] ${required} not found. Run \`npm run build\` from the repo root first.`);
    process.exit(1);
  }
}

rmSync(dist, { recursive: true, force: true });

// One self-contained file, so the packaged app needs no node_modules from the workspace.
await build({
  input: path('../src/main.ts'),
  platform: 'node',
  // ws only tries to load these optional native addons.
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  resolve: { extensionAlias: { '.js': ['.ts', '.js'] } },
  onLog(level, log, handler) {
    // Rolldown would leave the import in place, and the packaged app would fail to start.
    if (log.code === 'UNRESOLVED_IMPORT') handler('error', log);
    else handler(level, log);
  },
  output: { file: `${dist}main.cjs`, format: 'cjs' },
});

cpSync(ui, `${dist}ui`, { recursive: true });
