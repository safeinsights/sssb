---
'@sssb/kit': minor
---

### The starter runs the conformance suite and doctor

**Kind.** scaffold

**Action.** required

**What changed.** The starter gained `src/sssb.conformance.test.ts`, its `tests/contract/rls-contract.test.ts` calls
`contractSuite` from `@sssb/kit/testing/contract`, and its `package.json` gained the `sssb:doctor` (`sssb doctor`) and
`check:e2e` (`sssb check-e2e`) scripts and an `embedded-postgres` devDependency.

**To adopt.** Copy the starter's `src/sssb.conformance.test.ts` into each app, replace the body of each app's
`tests/contract/rls-contract.test.ts` with the starter's, and add the two scripts and the devDependency to each app's
`package.json`. Run `pnpm exec sssb doctor` once from any app: it checks every app of the workspace.
