// Runs after `changeset version`, for the files it doesn't update itself.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const versionOf = (dir) => JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')).version;

// The SDKs send SDK_VERSION to the server in their hello message.
for (const dir of ['packages/web', 'packages/react-native']) {
  const file = `${dir}/src/index.ts`;
  const source = readFileSync(file, 'utf8');
  const pattern = /export const SDK_VERSION = '[^']*';/;
  if (!pattern.test(source)) throw new Error(`SDK_VERSION not found in ${file}`);
  writeFileSync(file, source.replace(pattern, `export const SDK_VERSION = '${versionOf(dir)}';`));
}

// Otherwise package-lock.json keeps the old workspace versions and `npm ci` refuses to install.
execSync('npm install --package-lock-only --ignore-scripts --no-audit --no-fund', { stdio: 'inherit' });
