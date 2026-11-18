---
'@sssb/cdk': minor
'@sssb/create': minor
---

### `@sssb/tools` is a peer of `@sssb/cdk`, so tarballs install with no `overrides`

**Kind.** scaffold

**Action.** required

**What changed.** `@sssb/cdk` takes `@sssb/tools` as a peer at its own version instead of depending on it, so no SSSB
package depends on another. A release candidate's tarballs now install by URL as the notes say with pnpm 11's default
`blockExoticSubdeps` on and no `overrides`: before, the notes' `overrides` made pnpm refuse `@sssb/tools` as an exotic
subdependency (`ERR_PNPM_EXOTIC_SUBDEP`), and without them pnpm looked for it on npm. The release notes' install
lines and `pnpm create @sssb --sssb <dir>` no longer write `overrides`, and the starter's `infra/package.json` declares
`@sssb/tools` beside `@sssb/cdk`.

**To adopt.** In every package that depends on `@sssb/cdk` (each app's `infra/package.json`), add `@sssb/tools` at the
same release (the same tarball URL, or `file:` path, as your other packages use for it). Then delete the `@sssb/*`
entries from `overrides` in `pnpm-workspace.yaml` (the whole block if nothing else is in it) and the
`blockExoticSubdeps: false` setting, run `pnpm install`, and commit the lockfile.

**Now deletable.** A `blockExoticSubdeps: false` setting kept only for SSSB's tarballs, and `overrides` that map
`@sssb/*` packages to their tarballs.
