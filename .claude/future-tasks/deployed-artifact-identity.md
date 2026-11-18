# What synth cannot see about a deployment: the server's artifact, and a synth with validation off

**Priority:** P2 · **Status:** open
**Found by:** the independent review of ADR-0014's P9 (`@sssb/cdk`), 2026-11-18, which asked whether a
synthesized stack could ever run with fake adapters, the wrong app's migrations or another app's seam while
synth and every check pass. It found no accidental route. These are the deliberate or out-of-band ones left.

## What the `SssbApp` construct asserts, and where that stops

At synth the construct (`packages/cdk/src/sssb-app.js`, whose header lists every check) fails unless, among
others, the app's `@sssb/kit` is its own version, the server's final environment pins `APP_MODE=real` with neither
`DEMO_MODE` nor `E2E_BUILD`, the slug is the one `apps/<app>/config/app.ts` declares, a linked `@sssb/app-config`
is the app's own `apps/<app>/src/app-config`, and the migrator deploys the bundle this synth staged, carrying every
migration the app's registry names under a literal key. Each is seen failing in
`packages/cdk/src/sssb-app.test.js`. Four things are outside its reach:

1. **The server's code.** The construct ships a placeholder asset; the deploy pipeline uploads the real
   standalone zip. Nothing ties that zip to the app or to a real-mode build: another app's zip, or a
   `build:demo` zip, deploys under the asserted environment. The run mode is read from `process.env` at module
   load (`packages/kit/src/adapters/index.ts`), so a demo build under `APP_MODE=real` runs real adapters for
   everything dynamic. Whether any page prerendered during a simulated build bakes fake-mode output was not
   checked route by route.
2. **A synth with validation off.** `app.synth({ skipValidation: true })` skips every construct validation: the
   environment and bundle checks. The ones that run at construction (version, slug, seam link, migration keys,
   project root, esbuild) still hold. Reproduced: a server with `APP_MODE=simulated` and `DEMO_MODE=1`
   synthesized without error.
3. **Changes made after synth**: an environment edited in the console, a pipeline `run.sh` that exports a bypass,
   a CloudFormation macro or transform that rewrites the template at deploy time (`addTransform` synthesizes
   cleanly).
4. **A seam index that brings in another app's registry.** The check expects the names the index registers under
   literal keys, and refuses an index with migration files beside it and no literal key at all. Two shapes still
   pass: an app with no migration files of its own whose index re-exports another app's registry (reproduced by
   the review: the bundle named the index file and the other app's migrations, and the check expected nothing),
   and an index with a literal key that also spreads another registry (`...otherApp`), carrying both sets (read
   from `seamMigrationNames`, not run). Closing it means reading the registry as the framework does, not as text.

## The design sketched

- **An identity the runtime checks.** The construct sets `SSSB_APP_SLUG` on the server; the framework refuses to
  boot in real mode when it differs from the seam's `APP_SLUG` (`@sssb/app-config/identity`). That ties the
  uploaded zip to the app it was deployed as, and fails at the first request rather than never.
- **A Lambda backstop for the bypasses, considered and not chosen as is.** Refusing simulated mode whenever
  `AWS_LAMBDA_FUNCTION_NAME` is set closes 1–3 for fake adapters, but `params.domains.demo` names a public
  demo, which is a simulated `DEMO_MODE=1` build that may well be hosted on Lambda. A backstop needs an explicit,
  separately named opt-in for that deployment, and the production guard's test
  (`packages/kit/src/adapters/production-guard.test.ts`) pins the guard's opt-ins, so adding one is a deliberate
  change to that file.
- **The runbook's check stays the one artifact-mode check until then**: `docs/runbooks/deploy.md`, `/api/health`
  reporting `mode: "real"` after a deploy.
- **Pack and consume's synth.** The consumer copies `apps/starter/infra` but neither installs `@sssb/cdk` nor
  synthesizes it. Proving the construct from tarballs, in a workspace with two apps, belongs with ADR-0014's P12,
  when `@sssb/create` ships `apps/starter/infra/`.
