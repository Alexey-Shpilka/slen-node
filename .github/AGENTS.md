# .github

## Purpose
The CI of `@slen/sdk`. It reads no secret: a pull request from a fork runs exactly what a push to `master` runs.

## Key Files
| File | Description |
|------|-------------|
| `workflows/ci.yml` | `typescript` (Node 22: `npm ci`, typecheck, tests, build, the help slice `--check`, `npm pack --dry-run`) and `typescript-floor` (the built `dist/` loaded on Node 20.3.0 by `scripts/floor.mjs`) |
| `dependabot.yml` | weekly: the pinned actions, and the npm toolchain |

## For AI Agents
- **Every action is pinned to a commit**, with its version in a comment; Dependabot moves both. `permissions: contents: read`; every checkout is `persist-credentials: false`.
- **No secret, no other repository.** The checks that need the API's OpenAPI spec (`test/contract.test.ts`, `test/modules/spec.test.ts`, the spec part of `test/help-examples.test.ts`) skip without `SLEN_OPENAPI_SPEC`; they run with the spec where the contract is kept, against this repository's tags and `master`.
- **`npm ci` runs `prepare`**, which builds `dist/`: the same build an install from a tag of this repository makes. `npm run build` runs again after the tests so the gate does not lean on what `prepare` left.
- **The toolchain is Node 22; the floor is Node 20.3.0** — exactly, since a later 20.x has more than `engines` promises. The floor loads what ships, ESM and CommonJS, and takes it through the paths that lean on the runtime.
- **`contract/` and the JSON of `examples/help/` are copies**: a change to them comes from the contract's canon with `contract/SOURCE`, never as an edit here.
- **Releases**: a tag `vX.Y.Z` on `master` with its `CHANGELOG.md` line; nothing is published from CI.
