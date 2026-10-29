// The examples of the console's help section (`examples/help/<id>/node.ts`)
// import the package the way a consumer does — `from '@slen/sdk'` — and
// `test/help-examples.test.ts` runs them as they are written. Here that name is
// the source tree: the same alias `tsconfig.json` gives the compiler (`paths`).
// Nothing under `src/` or `test/` imports the package by its name.
//
// CommonJS on purpose. A config that is an ES module is bundled by Vite into a
// temporary file under `node_modules/`, and the local toolchain mounts
// `node_modules` read-only; a `.cjs` one is
// evaluated from memory.
const path = require('node:path');

module.exports = {
  resolve: {
    alias: [
      { find: /^@slen\/sdk$/, replacement: path.resolve(__dirname, 'src/index.ts') },
    ],
  },
};
