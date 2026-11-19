---
'@sssb/tools': patch
---

### The reusable workflow takes a `docs-only` fast path

**Kind.** scaffold

**Action.** optional

**What changed.** SSSB's reusable workflow (`.github/workflows/app-checks.yml`) takes a boolean input, `docs-only`,
false by default. With `true`, the `contract`, `e2e`, `demo-static` and `synth` jobs still run and report success
under their usual names, but run only a step saying they skipped, and `contract` starts no Postgres. Lint, typecheck,
the unit tests, `discover` and `all-checks` are unchanged. A caller that does not set it runs exactly what it did.

**To adopt.** Nothing, to keep the full run on every pull request. To skip the expensive jobs on a change your own CI
has judged harmless (one that touches only documentation, say), pass `docs-only:` as an expression your workflow
computes, after raising the workflow pin to this release, e.g. `docs-only: ${{ needs.changes.outputs.docs-only == 'true' }}`. Compute it
against the pull request's merge commit, never let a failed computation read as `true`, and never set it on a push to
your default branch.
