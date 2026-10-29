// The roots of `test/paths.ts` for the scripts Node runs without TypeScript (the help-slice exporter, the floor):
// that file is read as text, and each `export const NAME = new URL('…', import.meta.url);` is resolved against it.
import { readFileSync } from 'node:fs';

const FILE = new URL('../test/paths.ts', import.meta.url);
const LINE = /^export const (\w+) = new URL\('([^']+)', import\.meta\.url\);$/gm;

/** `{ PACKAGE, CONTRACT, EXAMPLES }`, each a URL of a directory. */
export function roots() {
  const found = {};

  for (const [, name, relative] of readFileSync(FILE, 'utf8').matchAll(LINE)) {
    found[name] = new URL(relative, FILE);
  }

  for (const name of ['PACKAGE', 'CONTRACT', 'EXAMPLES']) {
    if (found[name] === undefined) {
      throw new Error(`test/paths.ts has no line for ${name} that scripts/paths.mjs can read.`);
    }
  }

  return found;
}
