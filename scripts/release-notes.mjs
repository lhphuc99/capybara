// Prints the notes of the GitHub release for the current version: each package's changelog entry for it.
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const packages = ['apps/desktop', 'packages/cli', 'packages/web', 'packages/react-native', 'packages/core', 'packages/protocol'];
// What changesets writes for packages that the fixed group bumped without changes of their own.
const dependencyOnly = /^\s*- (Updated dependencies|@capybara-devtools\/[\w-]+@|capybara-devtools@)|^No changes in this release\.$/;
// A changeset that names several packages shows up in each of their changelogs; list it once.
const seen = new Set();

const parts = [];
for (const dir of packages) {
  const { name, version } = JSON.parse(read(`${dir}/package.json`));
  const file = `${dir}/CHANGELOG.md`;
  if (!existsSync(new URL(file, root))) continue;
  const section = read(file)
    .split(/^## /m)
    .find((part) => part.startsWith(`${version}\n`));
  if (!section) continue;

  // One entry per line, with the indented lines that continue a bullet.
  const entries = [];
  for (const line of section.split('\n').slice(1)) {
    if (/^\s+\S/.test(line) && entries.at(-1)?.startsWith('- ')) entries[entries.length - 1] += `\n${line}`;
    else entries.push(line);
  }
  const fresh = entries.filter((entry) => {
    if (dependencyOnly.test(entry)) return false;
    if (!entry.startsWith('- ')) return true;
    if (seen.has(entry)) return false;
    seen.add(entry);
    return true;
  });
  const kept = fresh.filter((entry, i) => {
    if (!entry.startsWith('### ')) return true;
    const next = fresh.slice(i + 1).find((e) => e.trim() !== '');
    return next !== undefined && !next.startsWith('### ');
  });
  const body = kept.join('\n').trim();
  if (body) parts.push(`## ${name}\n\n${body.replace(/^### /gm, '#### ')}`);
}

const { version } = JSON.parse(read('packages/cli/package.json'));
parts.push(
  [
    '## Install',
    '',
    `- CLI: \`npx capybara-devtools@${version}\``,
    `- SDKs: \`npm install @capybara-devtools/web@${version}\` or \`npm install @capybara-devtools/react-native@${version}\``,
    '- Desktop app: the files below. The builds are not signed yet, see the README for the first launch.',
  ].join('\n'),
);
console.log(parts.join('\n\n'));
