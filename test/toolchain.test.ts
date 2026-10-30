import { describe, expect, it } from 'vitest';

/**
 * Two compilers are installed: `typescript` (7, the build and the typecheck)
 * and `typescript-api` (6 under another name, for the compiler API the suite
 * and the slice exporter read the AST with; 7 has none). Both ship a `tsc`, and
 * `node_modules/.bin/tsc` is whichever npm linked last — a script that calls
 * a bare `tsc` may build with 6 and nobody would see it. So every script that
 * compiles names 7 by its path, `prepare` included through `build`.
 */

// The package has no `@types/node`; the member of `node:fs` used here is
// described structurally and loaded through a specifier the compiler does not
// try to resolve (as in `readme.test.ts`).
interface NodeFs {
  readFileSync(path: URL, encoding: 'utf8'): string;
}

const NODE_FS: string = 'node:fs';
const { readFileSync } = (await import(NODE_FS)) as NodeFs;

const MANIFEST = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
const TYPESCRIPT_7 = 'node node_modules/typescript/bin/tsc ';

describe('the toolchain', () => {
  it('compiles with TypeScript 7 by its path, never with the tsc npm linked last', () => {
    const compiling = Object.entries(MANIFEST.scripts).filter(([, command]) => /\btsc\b/.test(command));

    expect(compiling.map(([name]) => name).sort()).toEqual(['build', 'typecheck']);

    for (const [name, command] of compiling) {
      expect(command.replaceAll(TYPESCRIPT_7, ''), name).not.toMatch(/\btsc\b/);
    }

    expect(MANIFEST.scripts['prepare']).toBe('npm run build');
  });
});
