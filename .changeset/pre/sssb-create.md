---
'@sssb/create': patch
---

### `@sssb/create`: a new app workspace in one command

**Kind.** scaffold

**Action.** optional

**What changed.** `pnpm create @sssb <dir>` (`npm create @sssb <dir> -- …`) writes a new SSSB app workspace: the
starter under `apps/<slug>/`, its `infra/` included, renamed to the app's slug and display name; the workspace's
config on SSSB's presets (Vitest, the tsconfig base, the ESLint plugin) with its own knip, jscpd, gitleaks, Prettier,
commitlint and husky setup; the seam a workspace package (`<slug>-app-config`) the app takes as `@sssb/app-config`, with an
`exports` map covering every seam module the framework imports; `allowBuilds`, `dedupePeerDependents: false` and `sssb.apps`; the owner files from `--repo` and
`--owner`; `docs/cutover-checklist.md` with the framework's rows; `.claude/sssb-guide.md`, the app guide as `sssb guide` writes
it; and `.github/workflows/checks.yml`, which calls SSSB's reusable workflow pinned to a commit. Its `pnpm verify` runs
what that CI runs, but the secret scan. `--sssb <dir>` depends on packed tarballs instead of published versions.
The starter's comments and one static-demo test title no longer name SSSB's showcase, "the starter", paths into
SSSB's `spikes/`, build notes or decision log, or the framework's paths in SSSB's repository unqualified, so they read
true in the generated workspace. They still cite SSSB's ADRs by number.

**To adopt.** Nothing for an existing workspace; the starter's reworded comments are yours to take or leave. A new
one starts with `pnpm create @sssb <dir> --repo <owner/name> --owner <@handle>`, then `git init`, `pnpm install` and
`pnpm verify`, and requires the check `sssb / all-checks` on its default branch.
