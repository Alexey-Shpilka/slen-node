import { describe, expect, it } from 'vitest';
import * as paths from './paths.js';

interface ScriptPaths {
  roots(): Record<string, URL>;
}

const script = (await import(/* @vite-ignore */ new URL('scripts/paths.mjs', paths.PACKAGE).href)) as ScriptPaths;

describe('the roots', () => {
  it('are the same directories for the suite and for the scripts Node runs without TypeScript', () => {
    const read = Object.fromEntries(Object.entries(script.roots()).map(([name, url]) => [name, url.href]));

    expect(read).toEqual({ PACKAGE: paths.PACKAGE.href, CONTRACT: paths.CONTRACT.href, EXAMPLES: paths.EXAMPLES.href });
  });
});
