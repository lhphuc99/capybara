// Renders build/icon.png, the Windows and Linux icon, from assets/icon.svg with macOS's `sips`.
// The macOS icon keeps Apple's margins; elsewhere icons fill their square, so this crops to the shape.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const svg = readFileSync(path('../../../assets/icon.svg'), 'utf8').replace('viewBox="0 0 1024 1024"', 'viewBox="100 100 824 824"');
const dir = mkdtempSync(join(tmpdir(), 'capybara-icon-'));
try {
  writeFileSync(join(dir, 'icon.svg'), svg);
  execFileSync('sips', ['-s', 'format', 'png', join(dir, 'icon.svg'), '--out', path('../build/icon.png'), '-z', '1024', '1024'], { stdio: 'ignore' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
