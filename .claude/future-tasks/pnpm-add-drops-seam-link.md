# `pnpm add` in a generated workspace drops the kit's seam link

**Priority:** P1 · **Status:** open
**Found by:** the P13 plugin review (round 1 and round 2, 2026-11-18), walking the plugin's commands in a workspace
`@sssb/create` generated from packed tarballs, with pnpm 11.14.0. Reproduced three times, with `valibot`, `ms` and
`@axe-core/playwright`.

## The bug

A generated workspace sets `dedupePeerDependents: false` in `pnpm-workspace.yaml`, and the app links its seam
as a package: `"@sssb/app-config": "link:./src/app-config"` in the app's `package.json`, which `@sssb/kit` takes as
an OPTIONAL peer (`peerDependenciesMeta` in `packages/kit/package.json`). After a normal install the lockfile
resolves the app's kit with that peer, so its snapshot key carries the suffix
`(@sssb/app-config@apps+<app>+src+app-config)`.

`pnpm --filter <app> add <pkg>` from the workspace root, or `pnpm add <pkg>` in the app's directory, rewrites the
app's `@sssb/kit` resolution WITHOUT that peer: the suffix is gone from the lockfile, the app's
`node_modules/@sssb/kit` is a new instance with no `@sssb/app-config` beside it, and

- `pnpm sssb:doctor` fails: `one SSSB per importer, with its own seam: … its @sssb/kit (…) has no seam linked, not its
own apps/<app>/src/app-config`;
- `pnpm typecheck` fails inside the kit: `Cannot find module '@sssb/app-config/seed'`.

Neither `pnpm install` nor `pnpm install --force` restores it (the broken lockfile is self-consistent). Deleting
only `node_modules`, or only the lockfile, does not either.

## Reproduction (exact)

From an SSSB checkout:

1. Pack the packages, as `scripts/pack-and-consume.mjs` does: in each of `packages/kit`, `packages/tools`,
   `packages/eslint-plugin` and `packages/cdk`, `pnpm pack --pack-destination <tarballs>`.
2. Generate: `node packages/create/bin/create.js <dir>/ws --slug acme --sssb <tarballs> --yes`, then in `<dir>/ws`:
   `git init`, `pnpm install`, `pnpm sssb:doctor` (ok), and commit.
3. `grep -c '(@sssb/app-config@apps+acme+src+app-config)' pnpm-lock.yaml` prints 2.
4. `pnpm --filter acme add ms`.
5. `pnpm sssb:doctor` fails as above; the grep in step 3 prints 0.

## What works (both verified 2026-11-18, doctor ok, the grep prints 2 afterwards)

- **Edit, then install.** Write the dependency into the app's `package.json` by hand (`"ms": "^2.1.3"`), then
  `pnpm install`. The lockfile gains only the new package; the kit keeps its peer.
- **After a `pnpm add`.** Keep the `package.json` it edited, restore the lockfile
  (`git checkout HEAD -- pnpm-lock.yaml`), then `pnpm install`.

The plugin's commands that add a package (`/sssb:new-preset-operation`, `/sssb:new-port`, `/sssb:a11y-review`) carry
both, in a shared **Adding a package** section, and the plugin's gate (`tests/tooling/plugin.test.ts`) fails any
`pnpm add` a command tells an author to run. That is a workaround: an author or agent outside the plugin still
reaches for `pnpm add`, and the full clean reinstall (every `node_modules` and the lockfile) re-resolves the whole
tree to fix it.

## Candidate fixes (to investigate; none tried)

- **Declare the seam differently.** A required peer, or the app's seam as a `workspace:` package (a
  package manifest in the app's seam directory, listed in `pnpm-workspace.yaml`) rather than a `link:`, may let pnpm's peer
  resolution on `add` see it. Check what ADR-0014 part 5 rules out first: each importer must get its own instance.
- **`injectWorkspacePackages`** (or `dependenciesMeta.<pkg>.injected`) for the seam: pnpm then hard-links it as a
  package with a real version, which peer resolution handles like any other.
- **A `.pnpmfile.cjs` `readPackage` hook** in the generated workspace that re-asserts the app's
  `@sssb/app-config` peer on `@sssb/kit` every resolution, `add` included.
- **A `sssb add <pkg>` wrapper** in `@sssb/tools` that edits the app's `package.json` and runs `pnpm install` (the
  verified remedy), plus doctor's FAIL naming it and the lockfile restore.

Whichever lands: a test in the pack-and-consume probe (`scripts/pack-and-consume.mjs`) that runs
`pnpm --filter <app> add` in the consumer and asserts doctor stays ok, and the plugin's **Adding a package** section
and its gate rule relaxed to match.
