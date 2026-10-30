# .github

## Purpose
The CI and the release of `@slen/sdk`. No job reads a secret: a pull request from a fork runs exactly what a push to `master` runs, and a tag is published without an npm token.

## Key Files
| File | Description |
|------|-------------|
| `workflows/ci.yml` | `typescript` (Node 22: `npm ci`, typecheck, tests, build, the help slice `--check`, `npm pack --dry-run`) and `typescript-floor` (the built `dist/` loaded on Node 20.3.0 by `scripts/floor.mjs`) and `typescript-consumer` (the help examples compiled against the packed types on TypeScript 5.0 and 7 by `scripts/consumer.mjs`); also `workflow_call`, for the release |
| `workflows/release.yml` | on a pushed tag `v*`: `gates` (`ci.yml`, called) on the tag's commit, then `publish` — the tag checked against `master` and the version, `npm ci --ignore-scripts`, `npm publish` by trusted publishing |
| `dependabot.yml` | weekly: the pinned actions, and the npm toolchain; minors and patches in one PR per ecosystem, the majors of `typescript`, `typescript-api` and `vitest` ignored — they change the build or the suite, which is an iteration's work |

## For AI Agents
- **Every action is pinned to a commit**, with its version in a comment; Dependabot moves both. `permissions: contents: read`, plus `id-token: write` on `publish` alone; every checkout is `persist-credentials: false`.
- **No secret, no other repository.** The checks that need the API's OpenAPI spec (`test/contract.test.ts`, `test/modules/spec.test.ts`, the spec part of `test/help-examples.test.ts`) skip without `SLEN_OPENAPI_SPEC`; they run with the spec where the contract is kept, against this repository's tags and `master`.
- **`npm ci` runs `prepare`**, which builds `dist/`: the same build an install from a tag of this repository makes. `npm run build` runs again after the tests so the gate does not lean on what `prepare` left.
- **The toolchain is Node 22; the floor is Node 20.3.0** — exactly, since a later 20.x has more than `engines` promises. The floor loads what ships, ESM and CommonJS, and takes it through the paths that lean on the runtime.
- **`contract/` and the JSON of `examples/help/` are copies**: a change to them comes from the contract's canon with `contract/SOURCE`, never as an edit here.
- **A release is a pushed tag `vX.Y.Z`** (the steps: "Releasing" in the root `AGENTS.md`). `gates` calls `ci.yml`, so a release passes exactly what a push to `master` passes, on the tag's own commit; `publish` needs it, and before anything installs refuses a tag whose commit is not on `master` (`git merge-base --is-ancestor` against `origin/master`; the checkout fetches all history for it) and a tag that is not `v` + `version` of `package.json` and `SDK_VERSION` of `src/version.ts`.
- **Only `publish` has `id-token: write`**: the OIDC token it can mint is what npm trades for a publish of `@slen/sdk` (the trusted publisher on npmjs.com names this repository and `release.yml`), so no npm token exists anywhere. Every other job, the called ones of `ci.yml` too, runs with `contents: read` and cannot mint one.
- **Nothing but the build and npm runs beside that token**: `publish` has no cache (`package-manager-cache: false`; a poisoned cache would run there) and runs no dependency's install script (`npm ci --ignore-scripts`); `npm publish` runs `prepare`, which builds `dist/` with `tsc` on the tag's tree.
- **npm 11.5.1 or later** is what trusted publishing needs, and Node 22 ships npm 10: `publish` installs an exact npm 11. Dependabot does not see that pin — move it by hand.
- **Provenance** comes with trusted publishing from a public repository (`publishConfig.provenance` says the same): the version's page on npm links this repository, `release.yml` and the commit.
- **`release.yml` keeps its name**: the trusted publisher checks the name of the workflow a run started from; under another name npm refuses the publish (E404 or `ENEEDAUTH`) until the publisher on npmjs.com names the new file.
- **One release at a time** (`concurrency: release`, never cancelled in progress). GitHub keeps one waiting run per group: a third tag pushed while one release runs and another waits replaces the waiting one, which is then re-run by hand.
