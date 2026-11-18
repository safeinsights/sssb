# SSSB — agent guide

Multi-tenant web app foundation. Generic scaffold: hermetic local dev, ports and adapters, RLS tenancy.
Built to be adopted as a template — `docs/adopting.md` is the adopter guide; keep it truthful.
Architecture decisions are recorded in `docs/adr/`. Follow the Accepted ones (0001–0014) and don't relitigate them;
0014 is a plan carried out in steps (its implementation plan), so until a step lands, the tree and the docs
describe what is built, not what 0014 will build.
The philosophy behind these rules — thin slices, ports/adapters, hermetic dev, demo mode, one-app default —
is `docs/development-approach.md`; read it to understand the why, not just the what.
Anything needing real credentials is a row in `docs/cutover-checklist.md`, never a blocker.
Before adding a new vendor adapter, check the template/instance doctrine
(`docs/development-approach.md`, "What the template ships"): vendor code must pass the universality
or new-class test — otherwise it's a recipe in `docs/recipes/`. A new framework COMPONENT has its own
test in that section: does it encode a framework invariant, or is it generic presentation? A sign-in
screen does; a sortable table does not (`docs/recipes/list-kit.md`).

## Hard rules

- **Framework vs app line** (ADR-0012): the generic machinery is the workspace package
  **`packages/kit`** (imported as `@sssb/kit/...`) — ports, adapters, core, authz, db, i18n,
  email, inbound-email, service-auth, server-lib, observability, theme, the framework screens, the
  framework's message catalog, and the static demo's simulated world + shell (`@sssb/kit/demo-static/*`).
  Everything under `apps/*/src/` is an APP: `apps/*/src/app` (Next route files — they stay there
  forever), `apps/*/src/app-config` (the seam), `apps/*/src/domain`, its cards/screens in
  `apps/*/src/components`, `apps/*/src/demo-static`, and `apps/*/messages/*.json`. **There are TWO apps** — `apps/showcase` (the demo, exercising every capability)
  and `apps/starter` (the minimum an adopter keeps, and the framework's falsifier: it typechecks the
  whole of `packages/kit/src` against its own seam, so a framework module that assumes the showcase's
  tables or vocabulary fails to build). A change to the kit is not done until BOTH apps are green. The
  app extends the framework through the `@sssb/app-config/*` seam — register new subjects, jobs, event kinds, tables, and migrations there, and
  **never edit a framework base union or registry**. Lint-enforced: inside `packages/kit` the
  fence bans the app's `@/*` alias, `@app/seed`, a relative or absolute path (or `file:` URL) that lands in `apps/` or
  `packages/seed`, a `..` in any package or alias specifier, and any specifier through `node_modules`, by
  `import()` and in a type `import('…')` as well as in a declaration; the `@sssb/app-config/*` alias is the only
  channel back. `sssb/no-path-out-of-package` also bars any path out of `packages/kit`, an absolute path or `file:`
  URL even into it, and a shipped file's path to one the `files` allowlist leaves out (two real-Postgres contract
  tests are the named exceptions). **The framework must compile under `packages/kit/tsconfig.strict.json`**
  (the strict-flag set at the ES2022 lib floor; `pnpm typecheck` runs it), because adopters compile the shipped
  `.ts` under their own options. **`@sssb/kit`'s `files` allowlist in its `package.json` decides what ships**
  (tests and stories out; the conformance suite ships as source, `@sssb/kit/testing`); a new file that must ship, or a new import of a
  package the source needs, goes in the manifest — pack and consume checks the tarball. A package the app must
  share one copy of is a peer: `react`, `next`, `next-intl`, `@mantine/core`, `kysely` (the app's migrations get
  the framework's `Kysely`), the compiler and the global types an adopter's program shares (`typescript`,
  `@types/react`, `@types/node`), and `vitest`, optional, for the shipped tests; anything else, `@types/pg`
  included, is a dependency (`docs/decision-log.md`, "Package hygiene").
- **The kit's OWN tests run against its own app seam, never an app's** — `packages/kit/test-fixture`
  (outside `packages/kit/src` because that tree is what `@sssb/kit/*` resolves to and what ships; the
  fixture is neither). Living outside that tree buys NO exemption: every gate names `test-fixture/**`
  explicitly — the ESLint fence and the ports/hermetic bans, `.jscpd.json`, `knip.json`'s `project`,
  and the root `tsconfig.json`. It sat outside the fence once, which made it the one directory in
  `packages/kit` where importing an app's `@/*` or `@app/seed` was legal; a location is not a
  boundary. It is a conforming registration of every `@sssb/app-config/*` module the framework reads, with its own seed
  world, table + its migrations, job/webhook/notification kinds, inbound handler, catalog and route tree,
  and the ROOT `tsconfig.json` resolves `@sssb/app-config/*` there. Its vocabulary
  (`harbor`/`lakeside`, `depot`/`annex`/`steward`/`wharf`, `fixture-*`, `dockets`) is deliberately
  neither app's: **never reach for an app's slugs, tables or job kinds in a `packages/kit` test** —
  that regression is what the odd vocabulary exists to make obvious, and it is what used to leave
  `pnpm init-app --eject-showcase` with a red gate.
- **`@sssb/kit`'s public surface is `packages/kit/package.json`'s `exports` map** — 136 published subpaths
  (its `exports` keys minus `.` and `./package.json`; count it, never remember it);
  the rest of the package is internal and reachable only by relative import inside it. Lint-enforced
  (`sssb/public-surface`, which reads that map, so the map is the only list). Adding a module does NOT
  publish it; add the `exports` line deliberately, and never widen the map to silence the rule.
- **Vendor SDKs (`@clerk/*`, `@aws-sdk/*`, `@anthropic-ai/*`, `@sentry/*`, `posthog-*`, `mailgun.js`,
  `pg`) may only be imported inside an adapters directory**: `packages/kit/src/adapters/` for SSSB's
  ports, or `apps/*/src/adapters/real/` for a port the APP owns, meaning a vendor SSSB has no port for,
  which fails the universality and new-class tests (`docs/recipes/app-owned-adapter.md`). Everything
  else codes against the port: `@sssb/kit/ports/*`, or the app's `apps/*/src/ports/*` through its registry
  `apps/*/src/adapters/index.ts`, which takes the run mode from SSSB's `isSimulated` and loads `real/`
  only with `import()`. Lint-enforced (`tests/lint/app-owned-adapters.test.ts`): vendor imports, static
  or `import()`, outside those two directories; `process.env` anywhere else in `apps/*/src`,
  `apps/*/config` and `packages/kit/src` (bar the per-file exemptions `eslint.config.mjs` names, and
  tests), so the app's registry and fakes cannot read it; reading the run mode in an app's real adapters;
  a static import of an app's `adapters/real` anywhere in the app outside `real/` itself; and any import of
  `real/` from a fake. That the registry uses `isSimulated` is convention: lint cannot follow a value.
- **`@sssb/kit/core` is pure TypeScript** — no framework imports, and no JSX (it compiles to an import of
  `react/jsx-runtime`). Lint-enforced.
- **Screens are router-agnostic** — framework screens in `packages/kit/src/components`, app
  screens in `apps/*/src/components`; files under `apps/*/src/app` are thin wrappers. This keeps the `file://` static
  demo buildable — don't put logic in route files.
- **No hard-coded UI strings** — all copy goes through next-intl. The catalog is SPLIT: framework
  namespaces in `packages/kit/src/i18n/messages/{en,es}.json`, app namespaces in
  `apps/*/messages/{en,es}.json`, deep-merged at every load site. Lint-enforced (`react/jsx-no-literals`).
- **Deployment/service parameters exist only in `apps/<app>/config/params.ts`** — one file per app, the same keys in
  each (`tests/tooling/app-scaffold.test.ts` fails a drift), placeholders tracked in the cutover checklist. Secret
  values never enter the repo.
- **`pnpm dev` must stay hermetic**: no docker, no credentials, no network. Don't add `next/font/google`,
  telemetry, or anything that phones home.

## Workflow

- Formatting is `.editorconfig` + Prettier — run `pnpm lint:fix`, never hand-format.
- Conventional commits: lowercase subject, ≤100 chars (commitlint hook enforces).
- Before finishing any change: `pnpm verify` (typecheck + lint + unit + knip in parallel, then e2e,
  static-demo build, demo size budget, static-demo e2e). E2E needs Playwright chromium installed once:
  `pnpm exec playwright install chromium`.
- `pnpm verify` does NOT run `test:contract`, jscpd, coverage, gitleaks or pack and consume — CI runs those
  (`.github/workflows/checks.yml`). **Pack and consume** (`pnpm pack-and-consume`, ADR-0014 P2) packs
  `@sssb/kit` and runs an adopter-shaped workspace's verify against the tarball, outside this repo; a change
  to what the package ships, its manifest or the starter shows there first. Its gaps are named workarounds in
  `scripts/pack-and-consume/workarounds.mjs`, each removed by a later ADR-0014 step: never patch the consumer
  silently. It installs from a committed lockfile seed; when its notice says the resolution moved, refresh it
  with `pnpm pack-and-consume --update-lockfile` and commit `scripts/pack-and-consume/consumer-lock.yaml`.
  **Any migration/db change: run `pnpm test:contract` yourself** (the
  same RLS proofs on real Postgres, for EVERY app AND SSSB's fixture seam, each in its own
  database — SSSB's twice, once through the `pg` driver and once through the RDS Data API driver and its
  emulator, each also as a non-superuser owner, `packages/kit/src/db/owner-pass.ts`); after
  renumbering/renaming a migration, wipe local `.data` first.
  **Also wipe `apps/*/.data` after changing `packages/seed`** — the app seeder is guarded by "does this
  world have any rows yet", so new seed rows are invisible on an existing world and only CI sees them.
- **A list that can grow pages through `@sssb/kit/db/keyset`** — never a hand-rolled `LIMIT`/`OFFSET`. The
  primitive opens `withTenant` itself and re-runs your whole scoped query on every page, so page two
  cannot be scoped differently from page one; the cursor is client input, parsed by a total function
  (`parseDbKeysetCursor` → 400 on `invalid`) and the page size is clamped server-side. Its optional
  `orderBy` column is fixed per route (a cursor names no column), never client-chosen. Worked example:
  `apps/showcase/src/domain/db/tickets.ts` + `apps/showcase/src/app/api/tickets/route.ts`, with the
  index in `apps/showcase/src/app-config/db/migrations/1004_tickets_keyset_index.ts` and proofs in both
  RLS suites.
- **Tenant-scoped queries only via `db.withTenant()`** — `getDb()` is lint-banned in every module under
  `apps/*/src`, in SSSB's screens and in SSSB's fixture (`sssb/no-raw-db-handle`, deny-by-default: a new
  directory is covered before anyone names it; tests outside routes, screens and the fixture are the one
  exception).
  A module that truly needs the raw client is a named, reasoned exception in its app's own
  `apps/<app>/lint-exceptions.mjs` (path relative to the app, one existing file per entry, never a glob or a
  directory); nobody edits `eslint.config.mjs` for it. New tenant tables copy the RLS pattern from `apps/showcase/src/app-config/db/migrations/1001_tickets.ts` (app
  migrations are numbered ≥1001; framework migrations 0001–0999 live in
  `packages/kit/src/db/migrations` — ADR-0012).
- **Every mutating route handler (POST/PUT/PATCH/DELETE) must call `authorize(...)`**
  (`@sssb/kit/authz/authorize.ts`) — a build-time scan walks every `route.{ts,tsx,js,jsx,mjs}` under the app's
  whole `apps/<app>/src/app` tree, not only `api/` (Next serves a `route.ts` from anywhere there): the conformance
  suite's `authz-mutations` check, which each app runs from its own `apps/<app>/src/sssb.conformance.test.ts`
  (`packages/kit/src/authz/app-exemptions.ts`). The framework's own reference tree, `packages/kit/test-fixture/api`,
  is scanned by `packages/kit/src/authz/authorized-mutations.test.ts`. The scan judges EACH
  exported mutating handler, read with the TypeScript parser (`packages/kit/src/authz/route-scan.ts`), never
  the file's text: the handler must reach the `authorize` imported from `@sssb/kit/authz/authorize` on its own path,
  or its route must have a justified exemption and the handler must pass that entry's
  gate. A string, a comment, another verb, a dead branch, an uncalled function or a helper in another module
  does not count, and a handler the scan cannot follow fails. Exemption keys are paths relative to each app's
  `apps/<app>/src/app/api`, so a mutating route OUTSIDE `api/` can match no exemption and must call
  `authorize(...)` itself. The FRAMEWORK's exemption map is `packages/kit/src/authz/route-policy.ts`, and its
  staleness is measured against the FIXTURE tree, so a new framework exemption needs a file there to demonstrate it;
  the fixture's routes are scanned, never served. An app names its own in `apps/<app>/authz-exemptions.mjs`
  (`{ files, prefixes }`), measured against the app's own tree, and an entry that overlaps a framework one fails. **Every
  exemption MUST carry a `mustMatch`**, a gate checked on each verb (the handler IS the guard's call, reaches a
  port call, or opens with the simulated-mode 404), every name in it a value import kept under its exported name,
  so a local look-alike or an alias is not the gate — entries are matched by relative path in every root, so a
  gateless one would exempt an adopter's same-named route from authorization entirely. It proves the route is
  the KIND the reason describes, never the reason's whole claim; ADR-0012 states the limit.
- Dead code fails the gate (`knip`); never silence a finding with a broad ignore — add the narrowest
  possible `knip.json` entry, justified in `docs/build-notes.md`.
- The MERGED en/es catalogs must stay key- and placeholder-identical (unit-test enforced, both halves).
  CI
  additionally runs coverage reporting, jscpd duplication, and gitleaks secret scanning — see
  `.github/workflows/checks.yml`.
- Unit tests are colocated (`*.test.ts(x)`), run by Vitest — `vitest.config.ts` has ONE PROJECT PER APP
  because `@sssb/app-config/*` is a bare specifier and a single alias can only name one app, PLUS a `kit`
  project that runs the packages' suites against the framework's own seam
  (**`packages/kit/test-fixture`** — see below). SSSB's **conformance suite** (`@sssb/kit/testing`: the
  authorization scan, i18n partition/parity, the pglite RLS suite, migration order, the demo-presets check, the seam
  map; its checks and fixed test names are `packages/kit/src/testing/checks.json`) runs in every app from the app's
  own `apps/<app>/src/sssb.conformance.test.ts` (`tests/tooling/app-scaffold.test.ts` fails an app without one), and in the
  `kit` project against the fixture; that is what proves the seam against real apps rather than only against the
  fixture. A check is left out only by a named opt-out with a reason, and the suite fails a run that skips one. E2E
  lives in `apps/*/tests/e2e/` (showcase on :3000, starter on :3100). In a LINKED WORKTREE both ports
  are derived per checkout by `scripts/ports.mjs`, so parallel agent sessions don't adopt each other's
  dev server; `SHOWCASE_PORT`/`STARTER_PORT`/`LADLE_PORT`/`CONTRACT_PG_PORT` override it (the last
  also isolates `pnpm test:contract` between worktrees), and `print-port.mjs` reports it.
- **A test that needs a scratch directory calls `makeTestTmpDir()` / `makeTestTmpDirAsync()`**
  (`packages/kit/src/testing/tmp-dir.ts`; `tests/support/tmp-dir.ts` re-exports it) — never `mkdtemp`/`mkdtempSync`, which `sssb/no-direct-mkdtemp` bans in test
  files. The helper removes the directory when the file finishes; `test:unit`, `test:coverage` and
  `test:contract` run through `scripts/check-tmpdir-leak.mjs`, which fails the run if one survives. Do not
  call `vitest run` directly in a new script that is meant to gate — route it through that script.
- **E2E `workers` stays 1.** Every worker shares one `.data` behind one dev server, so parallelism buys
  flakes, not speed (measured; the old "10GB VM / OOM" reason was wrong). Parallelism belongs where the
  worlds are separate: across apps locally, across CI shards. Read
  `.claude/future-tasks/e2e-shared-world-blocks-parallelism.md` before raising it.
- Component workshop: `pnpm ladle` (screens AND react-email templates).
- **Scheduled work in dev only runs when something ticks it.** `pnpm tick` (`pnpm tick:starter`) calls the running
  dev server's `/api/webhooks/cron` once with the dev secret (`scripts/tick.mjs`); `DEV_TICK_SECONDS=<n> pnpm dev`
  does it every n seconds (`scripts/dev-tick.mjs`, which `pnpm dev` runs `next dev` through). The ticker is **off by
  default** and stays off under e2e (the playwright configs blank the variable, and refuse to load while a ticking
  dev server's marker is live) and the demo. The ticking is `scripts/ticker.mjs` (start, stop, status), policy-free. Never add a bypass to the
  route for either: it stays `withWebhookSecret`.
- Before opening a PR, run `/pre-pr` (verify + subagent branch review).
- **Merging: use a merge commit** (`gh pr merge --merge`) — that is what this repo's history is made of.
  **Never squash a PR another PR is stacked on**: squashing rewrites the commits, the stacked branch then
  carries changes that exist on `main` under a different SHA, and GitHub marks it `DIRTY`.
- **Never `--delete-branch` a PR that is another PR's base.** Retarget the dependents first
  (`gh pr edit <n> --base main`), then merge. A PR whose base branch is deleted is **auto-closed and
  cannot be reopened or retargeted** until the branch is restored —
  `git push origin <sha>:refs/heads/<name>` brings it back (the SHA survives in the merge commit), and
  restoring beats opening a replacement PR, which throws away the number, body and review history.
- **After a base PR merges, rebase every stacked branch immediately** —
  `git rebase --onto origin/main <old-base-tip> <branch>`. Do not wait for CI to flag it.
- **"no checks reported" is a merge problem, not a CI problem.** When a PR shows no checks at all, read
  `gh pr view <n> --json mergeStateStatus` first: GitHub cannot build a merge commit for a `DIRTY` PR, so
  the `pull_request` workflow never fires and an empty checks tab looks identical to a broken workflow.
- **A new gate must be seen to FAIL before you trust it.** Break the thing it guards, watch it go red,
  restore, watch it go green. A gate that has only ever passed is not evidence of anything — the
  doc-path guard shipped with a hole that only a deliberate failure run exposed.
- **`git checkout <path>` DISCARDS uncommitted work on that path** — it restores from the index, so on a
  file a subagent just wrote and nobody committed, it is a delete with no undo. Use it to revert your own
  edit, never to "reset" a file you have not committed. Commit subagent output before probing it.
- **Never switch branches with uncommitted work.** Git carries non-conflicting changes across a
  checkout, so a later `git add -A` silently commits another branch's work onto the wrong PR. Commit or
  `git stash -u` first, and read `git show --stat HEAD` after any `git add -A` commit to confirm what
  actually landed.
- **A rename or codemod is verified by grepping for the old token, never by the diff looking right.**
  Enumerate every specifier form before you start (`from '…'`, `import('…')`, `vi.mock('…')`,
  `require('…')`, config alias keys, `package.json` names) and write down what must NOT change, then
  grep for survivors and check each one against that list.
- Commands: `/verify`, `/new-port`, `/new-slice`, `/record-fixtures`, `/pre-pr`, `/branch-review`,
  `/sub-review`, `/repo-health`, `/a11y-review`, `/design-review`; capability scaffolds `/new-entity`,
  `/new-job`, `/new-actor`, `/new-notification-kind`, `/new-webhook-event`, `/new-tour`,
  `/new-preset`, `/new-preset-operation`.
- Record important lessons in `docs/build-notes.md`; unplanned decisions in `docs/decision-log.md`;
  designed-but-unbuilt work in `.claude/future-tasks/` (one file per item, listed in its `index.md`).
  Amend an ADR by appending a dated addendum — never by editing what its body said.
- **Doctrine docs are gated**: `tests/docs/doc-paths.test.ts` fails if a doctrine doc cites a repo path
  that doesn't exist. The doc set and its exemptions live in `tests/docs/doc-set.ts`, shared with
  `scripts/init-app.ts` so the gate and the adoption rewriter cannot disagree about scope. The dated
  records (`build-notes.md`, `decision-log.md`, ADR bodies and anything appended to them) are exempt — see
  `docs/README.md` for the split. If you move a directory, the gate is what tells you which docs you
  just falsified. A citation of `apps/showcase` or `apps/starter` is checked strictly while that app
  exists and passes where it does not (it then names SSSB's reference app, and a doc merged in from
  upstream must not turn an adopter's gate red); write `apps/<app>/…` when you mean the reader's own app.
- **The app's identity is a script, not a checklist**: `pnpm init-app <slug> [--repo <name>] [--eject-showcase]`
  (`scripts/init-app.ts`). Anything that names an app directory or the product's display name belongs
  in the surface that script covers — and **never hard-code the product name in a test**; specs read
  the app's own catalog via `apps/*/tests/catalog.ts`. See `docs/adopting.md`.
- At the end of a slice or before a PR, run the `doc-steward` agent on the branch diff — it
  proposes updates to development-approach, an ADR addendum, decision-log, build-notes, and the
  cutover checklist so the docs keep telling the truth.
