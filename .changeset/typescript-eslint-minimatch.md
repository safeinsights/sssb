---
'@sssb/eslint-plugin': patch
---

### The lint preset now requires typescript-eslint 8.73

**Kind.** none

**Action.** none

**What changed.** `@sssb/eslint-plugin` now depends on `typescript-eslint` `^8.73.0` (it was `^8.72.0`). 8.73.0 takes
`minimatch` 11.0.1 or later, the first release that fixes GHSA-g3hv-75wg-m249 (a denial of service through a crafted
glob; moderate, in your lint tooling only); 8.72 takes `minimatch` 10, which is affected.

**To adopt.** Nothing is required. A fresh install already resolves 8.73. A workspace whose lockfile still holds
`typescript-eslint` 8.72 moves to it on the next `pnpm install` after the `@sssb/eslint-plugin` upgrade; an
adopter that lists `typescript-eslint` itself keeps its own range.
