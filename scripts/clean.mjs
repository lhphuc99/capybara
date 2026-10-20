// Deletes the build output of the packages and the desktop app. tsc never removes what a deleted source file
// compiled to, and anything left in dist would be published.
import { readdirSync, rmSync } from 'node:fs';

for (const folder of ['packages', 'apps']) {
  for (const name of readdirSync(new URL(`../${folder}/`, import.meta.url))) {
    for (const output of ['dist', 'tsconfig.tsbuildinfo', 'test/tsconfig.tsbuildinfo']) {
      rmSync(new URL(`../${folder}/${name}/${output}`, import.meta.url), { recursive: true, force: true });
    }
  }
}
