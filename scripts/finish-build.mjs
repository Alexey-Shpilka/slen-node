// The package is `"type": "module"`, so every .js under it is ESM unless a
// nested package.json says otherwise. This drops that marker into the CommonJS
// build — the whole reason a dual build works without a bundler.
import { writeFileSync } from 'node:fs';

writeFileSync('dist/cjs/package.json', `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);
writeFileSync('dist/esm/package.json', `${JSON.stringify({ type: 'module' }, null, 2)}\n`);

console.log('dist/esm + dist/cjs marked');
