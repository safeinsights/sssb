---
'@sssb/tools': minor
---

### `sssb doctor` requires pnpm's default `nodeLinker`, and never hangs on a Vitest listing

**Kind.** seam

**Action.** required

**What changed.** `sssb doctor` now fails first, and checks nothing else, when pnpm installed the workspace with a
`nodeLinker` other than `isolated` (pnpm's default): `pnp` or `hoisted`, set in `pnpm-workspace.yaml`, a
`pnpm_config_node_linker` environment variable or a `--config.node-linker` flag. It fails the same way while
Plug'n'Play's `.pnp.cjs` is left at the workspace root, which `pnpm run` keeps loading after the setting is gone. SSSB
gives each app its own `@sssb/kit` linked to its own seam, which `hoisted` cannot (one copy serves every app); under
`pnp`, `pnpm run` resolves through Plug'n'Play's `.pnp.cjs`, where Vitest's listing never finishes. Before, under `pnp`
doctor passed when run directly and hung when run as `pnpm sssb:doctor`; under `hoisted` it failed without naming the
cause. Separately, each `vitest list` doctor runs is stopped after 120 seconds, with every process it started (on macOS
and Linux; on Windows only Vitest's own process), and reported as a problem, and once one listing runs out of time
doctor does not wait on the rest; `SSSB_DOCTOR_VITEST_TIMEOUT` (seconds) changes the limit.

**To adopt.** If `pnpm sssb:doctor` reports the installed layout, remove `nodeLinker` from `pnpm-workspace.yaml`, delete
`.pnp.cjs` at the workspace root if it is there, run `pnpm install`, and run doctor again. Nothing to do on pnpm's
default layout.
