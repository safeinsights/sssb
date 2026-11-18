---
'@sssb/tools': minor
---

### `sssb doctor` requires pnpm's default `nodeLinker`, and never hangs on a Vitest listing

**Kind.** seam

**Action.** required

**What changed.** `sssb doctor` now fails first, and checks nothing else, when pnpm installed the workspace with a
`nodeLinker` other than `isolated` (pnpm's default): `pnp` or `hoisted`, set in `pnpm-workspace.yaml`, `.npmrc` or
elsewhere. It fails the same way while Plug'n'Play's `.pnp.cjs` or `.pnp.loader.mjs` is left at the workspace root,
which `pnpm run` keeps loading after the setting is gone. SSSB gives each app its own `@sssb/kit` linked to its own seam
in `node_modules`, which only `isolated` does. Before, under `pnp` doctor passed when run directly and hung when run as
`pnpm sssb:doctor`; under `hoisted` it failed without naming the cause. Separately, each `vitest list` doctor runs is
stopped after 120 seconds, with every process it started, and reported as a problem, and once one listing runs out of
time doctor does not wait on the rest; `SSSB_DOCTOR_VITEST_TIMEOUT` (seconds) changes the limit.

**To adopt.** If `pnpm sssb:doctor` reports the installed layout, remove `nodeLinker` from `pnpm-workspace.yaml` (and
`node-linker` from `.npmrc`), delete `.pnp.cjs` and `.pnp.loader.mjs` at the workspace root if they are there, run
`pnpm install`, and run doctor again. Nothing to do on pnpm's default layout.
