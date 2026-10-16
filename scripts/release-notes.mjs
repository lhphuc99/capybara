// Prints the notes of the GitHub release for the current version: each package's changelog entry for it.
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

const packages = ['cli', 'web', 'react-native', 'core', 'protocol'];
// What changesets writes for packages that the fixed group bumped without changes of their own.
const dependencyOnly = /^\s*- (Updated dependencies|@capybara-devtools\/[\w-]+@|capybara-devtools@)|^No changes in this release\.$/;

const parts = [];
for (const dir of packages) {
  const { name, version } = JSON.parse(read(`packages/${dir}/package.json`));
  const file = `packages/${dir}/CHANGELOG.md`;
  if (!existsSync(new URL(file, root))) continue;
  const section = read(file)
    .split(/^## /m)
    .find((part) => part.startsWith(`${version}\n`));
  if (!section) continue;

  const lines = section.split('\n').slice(1).filter((line) => !dependencyOnly.test(line));
  const kept = lines.filter((line, i) => {
    if (!line.startsWith('### ')) return true;
    const next = lines.slice(i + 1).find((l) => l.trim() !== '');
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
