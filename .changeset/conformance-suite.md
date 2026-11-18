---
'@sssb/kit': minor
'@sssb/tools': minor
---

### The conformance suite, `sssb doctor` and `sssb check-e2e`

**Kind.** seam

**Action.** required

**What changed.** The framework's checks that must hold for every app now ship as a suite the app calls from its own
tree: `@sssb/kit/testing` (the authorization scan of the app's routes, i18n partition and parity, the pglite RLS
proofs, migration order, demo presets, the seam map) and `@sssb/kit/testing/contract` (the same proofs on real
Postgres as a non-superuser owner and as a superuser, and over the RDS Data API through its emulator). The kit no
longer ships its seam-conformance test files. `sssb doctor`, one run for every app of the workspace, fails unless
each singleton peer has one copy, every importer of `@sssb/kit` links its own seam, the `@sssb/*` packages share one
version, the Vitest config a bare `vitest` would load for each app runs every unit check, and some config runs every
contract check. It reports, without failing, any other Vitest config that runs an app's tests without the checks, the
narrowing flags the package.json scripts pass to vitest, and which script runs each contract config, since it cannot
see what CI runs. Playwright specs may reach the framework only through `@sssb/kit/testing/e2e`, which ships compiled
and seam-free, and `sssb check-e2e`, asking Playwright which files each config loads, fails a spec that reaches any
other framework file.

**To adopt.** In each app:

- Add `src/sssb.conformance.test.ts` holding
  `conformanceSuite({ appDir: path.resolve(import.meta.dirname, '..'), optOut: {} })`, with `conformanceSuite` from
  `@sssb/kit/testing`. A check is left out only by name, with a reason: `optOut: { '<check id>': '<why>' }`; the ids
  are in `@sssb/kit/testing/checks.json`.
- Make `tests/contract/rls-contract.test.ts` call `contractSuite({ port: portFor('contractPg'), optOut: {} })`, with
  `contractSuite` from `@sssb/kit/testing/contract` and `portFor` from `@sssb/tools/ports`, and add
  `embedded-postgres` to the app's devDependencies for local runs (CI can set `CONTRACT_DATABASE_URL` instead). Keep
  `test:contract` in CI: doctor proves the contract checks would run, not that CI runs them.
- An authorization exemption of the app's own goes in `authz-exemptions.mjs` at the app's root, each entry with a
  `reason` and a `mustMatch` gate; one that matches no route in the app, overlaps a framework entry, or is a prefix
  nested in another of the app's prefixes, fails.
- In Playwright specs, import webhook-signature helpers from `@sssb/kit/testing/e2e`, not `@sssb/kit/core/…`, and
  read app constants from modules that import nothing from SSSB but types.
- Run `sssb doctor` (once, from the workspace root) and `sssb check-e2e` (in each app) in verify and in CI, and read
  doctor's reports: if CI runs a Vitest config other than the one doctor holds to the checks, they do not run there.

**Now deletable.** A Vitest `include` that reaches the framework's test files under `node_modules`, with the default
`exclude` overridden to let them run; a copied real-Postgres contract harness (a `defineContractSuite` and its server
helper); and a hand-run `readlink -f` comparison of the app's and the framework's React, Next or Mantine copies.
