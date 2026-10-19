import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FROM_SOURCE_URL } from '../src/config';

const readme = new URL('../../README.md', import.meta.url);

/** GitHub's heading ids: lowercase, punctuation dropped, each space a hyphen. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

// Vercel may build this folder without the rest of the repository.
describe.runIf(existsSync(readme))('links into the README', () => {
  it('lead to headings it has', () => {
    const headings = new Set(
      readFileSync(readme, 'utf8')
        .split('\n')
        .filter((line) => /^#{1,6} /.test(line))
        .map((line) => slug(line.replace(/^#+ /, ''))),
    );
    const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const anchors = [...page.matchAll(/github\.com\/lhphuc99\/capybara#([^"'\s]+)/g)].map((match) => match[1]!);
    anchors.push(new URL(FROM_SOURCE_URL).hash.slice(1));
    // GitHub opens the README for #readme; it is no heading.
    const missing = anchors.filter((anchor) => anchor !== 'readme' && !headings.has(anchor));
    expect(anchors.length).toBeGreaterThan(2);
    expect(missing).toEqual([]);
  });
});
