---
'@sssb/tools': minor
---

### SSSB's CI checks as a reusable workflow an app's CI calls

**Kind.** scaffold

**Action.** optional

**What changed.** `.github/workflows/app-checks.yml` in `safeinsights/sssb` runs SSSB's checks for an app workspace:
lint, typecheck and unit tests with `sssb check-fences` in each app, the contract tests on a Postgres service, the e2e
shards, each app's static demo, an optional CDK synth, and `all-checks`, which fails unless every one of them ran and
passed. Each step is a `pnpm exec sssb ci <job>` command, and `sssb ci` gains the jobs it runs (`lint-typecheck-unit`,
`contract`, `matrix`, `synth`) and an `--apps` list.

**To adopt.** In the app's own workflow, beside its own jobs and triggers, add a job

```yaml
sssb:
    uses: safeinsights/sssb/.github/workflows/app-checks.yml@<full commit SHA>
    permissions:
        contents: read
    with:
        synth: ./apps/console/infra
```

never with `secrets: inherit`, and require the check `sssb / all-checks`. The workspace root needs `@sssb/tools` and
the scripts `lint`, `typecheck`, `test:unit` (or `test:coverage`) and `test:contract`; each app needs a Playwright
config and a `build:demo-static` script. The organization must allow public reusable workflows, and the repository's
Actions settings must allow them.

**Now deletable.** A copy of SSSB's `checks.yml` jobs in the app's workflow: the contract job with its Postgres
service, the e2e shard discovery and matrix, the static-demo job, and the infra synth step.
