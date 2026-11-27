# SSSB app guide

The rules for an app built on SSSB (`@sssb/kit`). Paths are relative to the app's own directory, the package that
depends on `@sssb/kit`. `pnpm exec sssb guide` copies this file into your repository under a hash stamp: edit nothing in
the copy, rerun the command after an upgrade, and review the diff. Most rules are enforced by the `@sssb/eslint-plugin`
preset, SSSB's conformance suite or `sssb doctor`; keep the rest by hand.

## The seam

- The app extends the framework only through the `@sssb/app-config/*` seam, the modules in `src/app-config/`.
  Register new subjects, jobs, event kinds, tables and migrations there. Never edit or patch a framework base union or
  registry.
- Import `@sssb/kit` only by a published subpath, a key of its `exports` map, never by a path into the package
  (`sssb/no-path-into-kit`). Everything else in the package is internal.

## Vendors, environment and parameters

- Vendor SDKs (`@clerk/*`, `@aws-sdk/*`, `@anthropic-ai/*`, `@sentry/*`, `posthog-*`, `mailgun.js`, `pg`) are
  imported only in an app's real adapters, `adapters/real/` (and in what runs outside the request path: `next.config.*`
  for the Sentry build plugin, the contract tests in `tests/contract/`, the deployment in `infra/`). Everything else
  codes against a port: `@sssb/kit/ports/*`, or a port the app owns. SSSB's own real adapters
  (`@sssb/kit/adapters/real/*`) load their SDK too, so every module of the app outside `adapters/real/` (which may
  build on one) and the vendor carve-outs above, tests, stories and scripts included, reaches one only with `import()`
  when `!isSimulated`, never by an import declaration (re-exports included; a type-only `import type` or
  `export type`, which loads nothing, is allowed).
- A vendor SSSB has no port for gets a port the app owns, under `src`: the port module (`ports/<name>.ts`), a registry
  (`adapters/index.ts`) that takes the run mode from SSSB's `isSimulated` (`@sssb/kit/adapters/index`) and loads the
  real adapter only with `import()`, a fake, and the real adapter in `adapters/real/`, the one directory that imports
  the SDK. Nothing imports `adapters/real/` statically, and a fake never imports it at all. Add the SDK to the ban in
  the app's own `package.json`: `"sssb": { "vendors": ["stripe", "stripe/*"] }`.
- An LLM call (`llm.complete`, `llm.stream`, `llm.runToolLoop`) has a deadline of 25 s by default, under the 30 s the
  server function has. A provider rate limit, an overloaded provider and a call past its deadline all arrive as
  `LlmUnavailableError` (`@sssb/kit/ports/errors`), which `withPortErrors` answers with a 503 and `Retry-After`: let it
  propagate. A job handler run by the CodeBuild runner, where no person waits and the process lives longer, passes a
  longer `timeoutMs` on the request; a route, and a job the in-process runner runs inside the server's function, never
  pass more than that function allows. `stream` throws it from the iteration, so a route that has begun its response cannot
  change the status.
- Read `process.env` only in `adapters/real/` (and never the run mode there), in Next's instrumentation hooks, in
  tests and in the app-root tool configs (Playwright, Vite). Every other module imports the resolved value: deployment
  parameters from `config/params.ts`, the run mode from `isSimulated`.
- Deployment and service parameters exist only in `config/params.ts`. Secret values never enter the repository.
- Declare which of SSSB's optional ports the app uses in `config/params.ts`'s `ports` (`llm`, `email`, `inboundEmail`,
  `jobs`, `storage`). A port the app does not use is `none`, never configured with placeholder values.
- A job handler never reads the seed (`@sssb/app-config/seed`), which a deployment does not have: it finds people with
  `ctx.auth.listMembers(orgSlug)`, and a person's locale with `ctx.resolveLocale`, where the runner provides one.
- A job kind's completion notifies its team's admins, whoever runs it and whatever it ends as. A routine kind, one a
  schedule runs every hour, says otherwise in the seam's optional `jobNotify` export in `src/app-config/jobs.ts`:
  `export const jobNotify: Partial<Record<AppJobKind, JobNotify>> = { 'sweep-items': 'failure' }`, with `JobNotify` from
  `@sssb/kit/core/jobs`. `'failure'` notifies only a failed job (one the in-process runner's sweep fails as lost included) and `'never'` nothing; a kind not
  named, and an app with no export, is `'always'`, and the framework's own kinds never notify. A refused run makes no
  `listMembers` call. If the static demo starts the kind, pass the same map as `useDemoWorld`'s `jobNotify`.
- A job kind is tried once unless the seam's optional `jobRetry` export in `src/app-config/jobs.ts` lets it retry:
  `export const jobRetry: Partial<Record<AppJobKind, JobRetry>> = { 'sweep-items': { attempts: 3, delaysMs: [60_000, 600_000] } }`,
  with `JobRetry` from `@sssb/kit/core/jobs` (at most 10 attempts and delays of at most 30 days, or the entry is ignored
  and the kind runs once; with no `delaysMs`, the webhook deliveries' backoff).
  Each attempt is a job row of its own, queued until its delay has passed (a service caller's job list leaves it out
  until then), and the scheduled tick starts it, so the tick's period (five minutes by default) is the floor under every delay. A retried handler runs again over whatever
  the failed attempt left behind: a kind that retries must be idempotent, and keys its side effects on
  `ctx.firstJobId`, the same on every attempt (`ctx.attempt` says which one it is). Only the last attempt's outcome
  notifies, so `jobNotify`'s `'failure'` means a failure with no attempts left. A build the CodeBuild runner loses without
  posting its webhook is never retried: nothing watches CodeBuild for a lost build. If the static demo starts the kind,
  pass the same map as `useDemoWorld`'s `jobRetry`.
- A route that submits a job for a person passes `requestedBy: user.id` to `submitJob` (`@sssb/kit/db/jobs`): when the
  team has no admin to tell (a fixed org source, `params.auth`, has none), the job's end reaches the person who started
  it, and a job submitted without one reaches no one. Under a fixed org source SSSB's `Job` rule admits no one (its
  roles are `none` and `restricted`), so authorize such a submission on a subject of your own.
- `pnpm dev` stays hermetic: no docker, no credentials, no network. Never add `next/font/google`, telemetry, or
  anything that phones home.
- Anything that needs real credentials, accounts or money is a row in the workspace's cutover checklist, never a
  blocker: the app boots, and is tested, without it.
- `src/proxy.ts` default-exports the app's proxy wrapped in `withAuthProxy` from `@sssb/kit/adapters/proxy`, and its
  `config.matcher` sends it every page and every `/api` route: in real mode SSSB's auth adapter needs its provider's
  middleware to have seen the request, and `withAuthProxy` runs that middleware around your proxy (loading none of it
  in simulated mode). Never import the provider's middleware yourself. A page path has no dot in it (the generated
  matcher leaves those out, as static files), and Next buffers at most `proxyClientMaxBodySize` (10MB by default) of a
  body the proxy sees, so an upload limit above it raises
  `experimental.proxyClientMaxBodySize` in `next.config.ts` too.
- The locale layout (`src/app/[locale]/layout.tsx`) mounts `RealAuthProviders` from
  `@sssb/kit/adapters/real/providers` in real mode, loaded with `import()` when `!isSimulated`: SSSB's real
  sign-in and invite forms call the auth provider's client hooks, which throw outside it. The conformance suite's
  `real-auth-provider` check fails a page that reaches one of those forms through its imports unless a layout or
  template wrapping it reaches the provider.

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
  `src/app-config/db/migrations/1001_items.ts`, the generated app's first migration (once you have removed it, read it
  in SSSB's repository at your release), and its isolation proofs go in `src/app-config/db/rls-proofs.ts`.
- A role is cluster-wide, so a migration that creates one of the app's own creates it only where it does not exist
  yet: a `DO` block that runs `CREATE ROLE reviewer NOLOGIN` only when
  `NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'reviewer')`. Keep it an ordinary role, before and after every
  migration: NOLOGIN, never CREATEDB, CREATEROLE, SUPERUSER, BYPASSRLS or REPLICATION, granted no privilege on a server
  parameter (`GRANT ... ON PARAMETER`), the owner of no database or tablespace, and a member of no role (at any depth)
  but `app_user` and the app's other named roles (`GRANT reviewer TO app_user` is fine;
  `GRANT pg_read_all_data TO reviewer` is not). Leave the framework's `app_user` ordinary too, since every later owner
  gets ADMIN on it as well: never change its attributes, give it no parameter privilege, database or tablespace, and grant it only
  the app's named roles, never a `pg_*` one. Name your role in `appRoles`, exported beside `appMigrations` from
  `src/app-config/db/migrations/index.ts`: `export const appRoles = ['reviewer'] as const`. The contract tests' owner
  pass grants a later database owner ADMIN on exactly those roles and `app_user`, as Aurora's master user holds on a
  role it created, and refuses a role that is not ordinary; the conformance suite's `app-roles` check fails a role the
  migrations create and `appRoles` does not name, a name they do not create, and a named role or `app_user` they leave
  more than ordinary. Never name `app_user` or a `pg_*` or `rds_*` role.
- After any migration or database change, run the contract tests on real Postgres (`pnpm test:contract` from the
  workspace root). After renumbering or renaming a migration, wipe
  the local `.data` first.

## Authorization

- Every exported route handler in a `route.ts` anywhere under `src/app`, not only under `src/app/api`, calls
  `authorize(...)` from `@sssb/kit/authz/authorize` on its own path: a mutation (POST, PUT, PATCH, DELETE) and a read
  (GET, HEAD, OPTIONS) alike, as `src/app/api/items/route.ts` does for both (the generated app's; once you have removed
  it, read it in SSSB's repository at your release). The conformance suite's `authz-mutations` check reads each
  handler: a string, a
  comment, a dead branch or a helper in another module does not count. Neither does a call whose denial cannot stop
  the handler: in an `async` helper or a callback whose promise the handler neither awaits nor returns, in a callback
  handed to a function the route file defines, in a callback a timer, a listener, `after()` or a `.catch`/`.finally`
  runs, or in a `try` whose `catch` does not rethrow. `await` the helper that authorizes, and let `withPortErrors`
  answer the 403. Over many items, `await Promise.all(items.map(...))`; `Promise.allSettled` does not count, and
  neither does a `.then(...)` chained after it.
- The check proves that a handler can reach `authorize(...)`, not that every path through it does, nor that it
  comes before the mutation. Call it before the mutation and before any `try` (except one whose `catch` always
  rethrows, as in the next rule), on a path every request takes: after `auth.requireUser()` and the lookups that give it the org, never
  inside a condition or a loop.
- A person who may not act gets the same answer, status and body, whether or not a thing the request names exists:
  a row by its id in the path, an org by a slug in the body, anything a lookup keyed by request input finds. So no such
  lookup answers before `authorize` when the session alone can decide: authorize on the active org the session
  resolves to first, then look the thing up, scoped to the active org (another org's row is missing too). When the
  decision needs the row itself (a two-sided subject, whose requester and responder orgs only the row knows), the
  lookup comes first, and a missing row and a refusal are the one error:
  `if (!row) throw new NotFoundError()`, then
  `try { authorize(…) } catch (error) { throw error instanceof ForbiddenError ? new NotFoundError() : error }`, both
  errors from `@sssb/kit/ports/errors`, so `withPortErrors` gives both one answer. That `catch` always rethrows, so the
  check still counts the call. The check cannot see the order of a lookup and an `authorize`, so this rule is kept by
  hand; pin it with a route test that sends an existing id and a missing one as a person who may not act, and expects
  identical answers.
- A Server Action is a POST endpoint: every export of a `'use server'` file, and every function whose body opens
  with `'use server'`, calls `authorize(...)` by the same rules, lives under `src`, and can match no exemption. The
  app serves routes from `src/app` alone: a root-level `app/` directory, a `pages/api` directory, or a file named
  `route.<ext>` the check does not read (`route.mts`, a custom `pageExtensions`) fails it.
- An exemption is an entry in the app's `authz-exemptions.mjs` (`{ files, prefixes }`, keys relative to
  `src/app/api`), with a reason and a `mustMatch` gate; it covers every verb of the routes it names, each judged on
  its own. A route outside `src/app/api` can match no exemption.
- A route or screen that reads org-scoped data authorizes the read too, as `src/app/api/items/route.ts`'s GET does
  (`authorize(user, orgId, 'read', …)`): the session's org says where a person is placed, not that they may read there.
  The role `none` (a fixed org source gives it to every signed-in user by default: `params.auth`) is placed in the home
  org with no standing in it. The check enforces it for route handlers (a screen and a metadata route such as
  `sitemap.ts` or `opengraph-image.tsx` are kept by hand), and does not guess which reads are org-scoped: a read
  handler that names an import (other than those below), a helper, `fetch` or `process.env` authorizes. A
  read of the caller's own things authorizes its self-only subject (`Notification`, `NotificationPref`), and a service
  caller its machine actor. A read handler that reads nothing passes without it: it names nothing from outside itself
  but inert globals (`Response`, `Date`, `URL`, `JSON`), a `const` bound to a primitive literal (not an object or
  array), `NextResponse`, `redirect`, `permanentRedirect` and `notFound` from `next/navigation`, and SSSB's `appMode`
  and `isSimulated`, so it works only on its request, as a liveness probe does, or a CORS preflight whose headers are
  written inline. Any other read that is genuinely not org-scoped (a public one)
  names an exemption.
- In `appAbilityRules`, grant org-scoped access through the `sameOrg` you are handed, never by a role alone: `sameOrg` is
  false for a person without standing, and a rule that grants because a role is not some other role would grant
  `none` too.
- Under a fixed org source (`params.auth.orgSource` `'fixed'`) everyone has the role `none` or `restricted`, and both
  are restricted (`AuthUser.restricted` and the actor's `restricted`), so `restricted` cannot tell your own admins from
  anyone else. Grant your own people from your own data (a field on the subject, such as its publishers; your own table
  in a route or screen) BEFORE any denial on `restricted`, in `appAbilityRules` and wherever a route or screen reads
  `user.restricted`: a check that denies on `restricted` first locks out everyone, your own admins included. Key that
  grant on `actor.userId`, never an email, which another product on a shared instance may let anyone claim. Every
  person credential reaches your rules (a token, an inbound email: the same `userId`), so a grant meant for the person
  at the keyboard also checks `actor.credential?.kind === 'session'`. Your rules see `none` in no org (`sameOrg` is
  false), so a grant that must be scoped to the home org needs `defaultRole: 'restricted'`.

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
  `optOut: { '<check id>': '<why>' }`. `sssb doctor` fails when the Vitest config does not run them. The suite's
  `appDir` is the app's own directory: it refuses, while the file is collected, one that is not the package the suite
  file sits in.
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
- The Simulator panel on `pnpm dev` is SSSB's: `src/app/api/simulator/[...path]/route.ts` serves it and the locale
  layout renders it, both in simulated mode only. Each handler in that route file opens with the simulated-mode 404 and
  imports SSSB's handler after it; that first line is what exempts the route from `authorize(...)`. A simulated-only
  POST route of your own (a dev sign-in, a Simulator route you add) also refuses a request that is not
  `application/json`, right after that first line, as SSSB's handler does: a page on another site can send a form or
  plain-text POST to a developer's machine without a preflight.
- In a linked git worktree the app's ports are derived per checkout, so parallel sessions never adopt each other's dev
  server; `pnpm exec sssb port`, run from the app, prints its port. An app declares its port slot in its package.json,
  `"sssb": { "port": { "name": "ledger", "default": 3800 } }`, and reads its override from `LEDGER_PORT`; its scripts and
  Playwright config name no slot (`sssb tick`, `sssb dev-tick`, `originForApp(__dirname)`), so they read it. Every app of
  a workspace needs a slot of its own, which `sssb doctor` checks: `pnpm exec sssb add-app <slug>` gives a new app one.
- Before finishing a change, run `pnpm verify` from the workspace root. Format with `pnpm lint:fix`, never by hand.
  Commit messages are conventional commits; the commit-msg hook runs commitlint.
