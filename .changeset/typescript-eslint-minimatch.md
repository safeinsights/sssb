---
'@sssb/eslint-plugin': patch
---

### The lint preset now requires typescript-eslint 8.73

**Kind.** scaffold

**Action.** optional

**What changed.** `@sssb/eslint-plugin` now depends on `typescript-eslint` `^8.73.0` (it was `^8.72.0`). 8.73.0 takes
`minimatch` 11.0.1 or later, the first release that fixes GHSA-g3hv-75wg-m249 (a denial of service through a crafted
glob; moderate, in your lint tooling only); 8.72 takes `minimatch` 10, which is affected. A workspace generated at 0.2.0
or earlier also lists `typescript-eslint` `^8.72.0` in its own root `devDependencies`, and that range is what keeps 8.72
and `minimatch` 10 in its lockfile.

**To adopt.** Raise the workspace root's `typescript-eslint` to `^8.73.0` (or run `pnpm update typescript-eslint -r`) in
the same change that upgrades `@sssb/eslint-plugin`, so the workspace holds one copy of it, at 8.73. A workspace
generated from this release on already has that range.
