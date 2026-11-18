---
'@sssb/create': patch
---

### The starter typechecks its `infra/`

**Kind.** scaffold

**Action.** optional

**What changed.** The starter's `infra/` has a `tsconfig.json` of its own (it extends the app's, takes Node's types
and includes `infra/**/*.ts`), and the app's `typecheck` script runs it after the app's own program:
`next typegen && tsc --noEmit && tsc --noEmit -p infra`. The deployment's code was checked only by `synth` before; it
stays out of the app's program, so `next build` does not typecheck the CDK's declarations.

**To adopt.** Copy the starter's `infra/tsconfig.json` into each `apps/<app>/infra/`, and append
`&& tsc --noEmit -p infra` to each app's `typecheck` script. A workspace whose root `typecheck` fans out over
`apps/*` reaches it with no other change.
