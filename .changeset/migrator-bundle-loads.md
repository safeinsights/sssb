---
'@sssb/cdk': patch
---

### The Migrator Lambda loads

**Kind.** operator

**Action.** optional

**What changed.** `SssbApp`'s Migrator crashed as it loaded, before migrating anything, with `Dynamic require of
"events" is not supported`, on both network shapes: esbuild's ESM bundle of the handler inlines `pg`, whose CommonJS
`require` of Node's own modules has nothing to call in an ES module. The bundle now starts by defining `require` with
Node's `createRequire`. Every Node.js function `SssbApp` builds (the Migrator, the body-hash Lambda@Edge, the scheduled
tick) is now loaded in Node by SSSB's tests, so a bundle that cannot load fails CI.

**To adopt.** If your first migrate on 0.6.0 failed this way, upgrade `@sssb/cdk`, run `cdk deploy` (which rebuilds the
Migrator's bundle), and invoke the Migrator again; it migrates from where the database stands, which is empty. Nothing
else changes, and a stack that has not deployed yet only needs the upgrade.

**Now deletable.** A `bundling.banner`, or a `format` override, added to the Migrator through an escape hatch to make it
load.
