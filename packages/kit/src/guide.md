# SSSB app guide

The rules for an app built on SSSB (`@sssb/kit`). Paths are relative to the app's own directory, the package that
depends on `@sssb/kit`. `pnpm exec sssb guide` copies this file into your repository under a hash stamp: edit nothing in
the copy, rerun the command after an upgrade, and review the diff. Most rules are enforced by the `@sssb/eslint-plugin`
preset, SSSB's conformance suite or `sssb doctor`; keep the rest by hand.

## The seam

- The app extends the framework only through the `@sssb/app-config/*` seam, the modules in `src/app-config/`.
  Register new subjects, jobs, event kinds, tables and migrations there. Never edit or patch a framework base union or
  registry.
- Import `@sssb/kit` only by a published subpath, a key of its `exports` map. Everything else in the package is
  internal.

## Vendors, environment and parameters

- Vendor SDKs (`@clerk/*`, `@aws-sdk/*`, `@anthropic-ai/*`, `@sentry/*`, `posthog-*`, `mailgun.js`, `pg`) are
  imported only in an app's real adapters, `adapters/real/` (and in what runs outside the request path: `next.config.*`
  for the Sentry build plugin, the contract tests in `tests/contract/`, the deployment in `infra/`). Everything else
  codes against a port: `@sssb/kit/ports/*`, or a port the app owns.
- A vendor SSSB has no port for gets a port the app owns, under `src`: the port module (`ports/<name>.ts`), a registry
  (`adapters/index.ts`) that takes the run mode from SSSB's `isSimulated` (`@sssb/kit/adapters/index`) and loads the
  real adapter only with `import()`, a fake, and the real adapter in `adapters/real/`, the one directory that imports
  the SDK. Nothing imports `adapters/real/` statically, and a fake never imports it at all. Add the SDK to the ban in
  the app's own `package.json`: `"sssb": { "vendors": ["stripe", "stripe/*"] }`.
- Read `process.env` only in `adapters/real/` (and never the run mode there), in Next's instrumentation hooks, in
  tests and in the app-root tool configs (Playwright, Vite). Every other module imports the resolved value: deployment
  parameters from `config/params.ts`, the run mode from `isSimulated`.
- Deployment and service parameters exist only in `config/params.ts`. Secret values never enter the repository.
- `pnpm dev` stays hermetic: no docker, no credentials, no network. Never add `next/font/google`, telemetry, or
  anything that phones home.
- Anything that needs real credentials, accounts or money is a row in the workspace's cutover checklist, never a
  blocker: the app boots, and is tested, without it.

## Data

- Tenant-scoped queries run only inside `db.withTenant()`. `getDb()` is banned in every module under `src`
  (`sssb/no-raw-db-handle`); tests are exempt, except a route's or a screen's. A module that truly needs the raw
  client is a named entry, with its reason, in the app's `lint-exceptions.mjs`: a path relative to the app, one
  existing file per entry, never a glob or a directory.
- A list that can grow pages through `@sssb/kit/db/keyset`, never a hand-rolled `LIMIT`/`OFFSET`. Parse the cursor
  with `parseDbKeysetCursor` and answer 400 when it is `invalid`; clamp the page size on the server; fix the
  `orderBy` column per route, never from the client.
- App migrations live in `src/app-config/db/migrations/`, numbered 1001 and up (0001–0999 are the framework's), and
  are listed in `src/app-config/db/migrations/index.ts`. A new tenant table copies the RLS pattern of
  `src/app-config/db/migrations/1001_items.ts`, and its isolation proofs go in `src/app-config/db/rls-proofs.ts`.
- A role is cluster-wide, so a migration that creates one of the app's own creates it only where it does not exist
  yet: a `DO` block that runs `CREATE ROLE reviewer NOLOGIN` only when
  `NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'reviewer')`. Keep it an ordinary role, before and after every
  migration: NOLOGIN, never CREATEDB, CREATEROLE, SUPERUSER, BYPASSRLS or REPLICATION, and a member of no role (at any
  depth) but `app_user` and the app's other named roles (`GRANT reviewer TO app_user` is fine; `GRANT pg_read_all_data
TO reviewer` is not). Name it in
  `appRoles`, exported beside `appMigrations` from `src/app-config/db/migrations/index.ts`:
  `export const appRoles = ['reviewer'] as const`. The contract tests' owner pass grants a later database owner ADMIN on
  exactly those roles, as Aurora's master user holds on a role it created, and refuses a role that is not ordinary;
  the conformance suite's `app-roles` check fails a role the migrations create and `appRoles` does not name, a name
  they do not create, and a named role they leave more than ordinary. Never name `app_user` or a `pg_*` or `rds_*` role.
- After any migration or database change, run the contract tests on real Postgres (`pnpm test:contract` from the
  workspace root). After renumbering or renaming a migration, wipe
  the local `.data` first.

## Authorization

- Every exported mutating route handler (POST, PUT, PATCH, DELETE) in a `route.ts` anywhere under `src/app`, not only
  under `src/app/api`, calls `authorize(...)` from `@sssb/kit/authz/authorize` on its own path, as
  `src/app/api/items/route.ts` does. The conformance suite's `authz-mutations` check reads each handler: a string, a
  comment, a dead branch or a helper in another module does not count.
- An exemption is an entry in the app's `authz-exemptions.mjs` (`{ files, prefixes }`, keys relative to
  `src/app/api`), with a reason and a `mustMatch` gate. A mutating route outside `src/app/api` can match no
  exemption.

## UI

- No hard-coded UI strings: all copy goes through next-intl, accessible names, placeholders, titles and alt text
  included (`sssb/no-jsx-literals`, `sssb/no-literal-a11y-copy`). The app's namespaces live in `messages/en.json` and
  `messages/es.json`; the framework ships its own catalog, and the two are deep-merged wherever messages load. The
  merged catalogs stay key- and placeholder-identical.
- Screens are router-agnostic: they live in `src/components`, and the files under `src/app` are thin wrappers with no
  logic, so the `file://` static demo still builds.

## Tests

- Keep `src/sssb.conformance.test.ts` (SSSB's conformance suite) and `tests/contract/rls-contract.test.ts` (the
  contract runner on real Postgres). Leave a check out only by a named opt-out with its reason,
  `optOut: { '<check id>': '<why>' }`. `sssb doctor` fails when the Vitest config does not run them.
- A test that needs a scratch directory calls `makeTestTmpDir()` or `makeTestTmpDirAsync()` from
  `@sssb/tools/testing/tmp-dir`, never `mkdtemp` directly. A script that runs Vitest as a gate goes through
  `sssb check-tmpdir-leak`.
- E2E specs live in `tests/e2e/` and reach the framework only through `@sssb/kit/testing/e2e` (`sssb check-e2e`).
  Playwright's `workers` stays 1: every worker shares one `.data` behind one dev server.
- Dead code fails `knip`. Never silence a finding with a broad ignore; add the narrowest entry, with its reason.

## The dev loop

- Scheduled work runs in dev only when something ticks it: the app's `pnpm tick` calls the running dev server's cron
  route once, and `DEV_TICK_SECONDS=<n> pnpm dev` ticks it every n seconds. The ticker is off by default and stays off
  under e2e. The cron route (`src/app/api/webhooks/cron/route.ts`) stays behind `withWebhookSecret`: never add a
  bypass for the ticker.
- In a linked git worktree the app's ports are derived per checkout, so parallel sessions never adopt each other's dev
  server; `pnpm exec sssb port`, run from the app, prints its port.
- Before finishing a change, run `pnpm verify` from the workspace root. Format with `pnpm lint:fix`, never by hand.
  Commit messages are conventional commits; the commit-msg hook runs commitlint.
