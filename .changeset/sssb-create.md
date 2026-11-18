---
'@sssb/create': patch
---

### `@sssb/create`: a new app workspace in one command

**Kind.** scaffold

**Action.** optional

**What changed.** `pnpm create @sssb <dir>` (`npm create @sssb <dir>`) writes a new SSSB app workspace: the starter
under `apps/<slug>/`, its `infra/` included, renamed to the app's slug and display name; the workspace's config on
SSSB's presets (Vitest, ESLint, the tsconfig base, knip, jscpd, gitleaks, Prettier, the hooks); the seam linked as
`@sssb/app-config` with an `exports` map covering every seam module the framework imports; `allowBuilds`,
`dedupePeerDependents: false` and `sssb.apps`; the owner files from `--repo` and `--owner`; and
`.github/workflows/checks.yml`, which calls SSSB's reusable workflow pinned to a commit. `--sssb <dir>` depends on
packed tarballs instead of published versions. The starter's comments no longer name SSSB's showcase or the
framework's paths in SSSB's repository, so they read true in the generated workspace.

**To adopt.** Nothing for an existing workspace. A new one starts with `pnpm create @sssb <dir> --repo <owner/name>
--owner <@handle>`, then `pnpm install` and `pnpm verify`, and requires the check `sssb / all-checks` on its default
branch.
