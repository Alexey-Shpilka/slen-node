/**
 * The roots the suite and the scripts read: the package, its copy of the contract and its examples.
 * One line per root, `export const NAME = new URL('…', import.meta.url);`: `scripts/paths.mjs` reads them as text.
 */
export const PACKAGE = new URL('../', import.meta.url);
export const CONTRACT = new URL('../contract/', import.meta.url);
export const EXAMPLES = new URL('../examples/', import.meta.url);
