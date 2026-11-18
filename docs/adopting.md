# Adopting this template

Adoption is one command:

```sh
pnpm install                                # boots hermetically: no docker, no credentials, no network
pnpm init-app acme --name "Acme Research" --repo acme-research   # rename the app you keep; --dry-run previews it
pnpm install && pnpm verify                 # the workspace changed; prove it still holds
```

Commit `pnpm-lock.yaml` with the rest. That middle line changes the workspace, so the lockfile
changes too — and CI installs with `--frozen-lockfile` by default, so a commit that leaves it behind
fails your first push with an error that never mentions `init-app`.

That middle line renames the app you keep and repoints every file that named it. What it deliberately
leaves for you — deployment params, seed data, cutover rows, your GitHub owner and repo name — it prints when
it finishes.

Adding `--eject-showcase` also deletes the demo app, and the gate stays green when you do — SSSB's own
tests run against SSSB's own fixture seam (`packages/kit/test-fixture`), not against the demo's world.
**Still do it last**: the showcase is the worked example you will read most in week one. Build your
first slices with it present; drop it when you stop reading it.

The rest of this document is what that command does not do: which parts of the tree are yours, how
your product extends the framework, and the discipline that keeps the whole thing honest.

## What is here

Three kinds of thing live in this repo (see
[ADR-0012](adr/0012-framework-app-line-and-registration.md) for the full line):

- **The framework** (**SSSB**): the workspace package `packages/kit`, imported as `@sssb/kit/...` —
  ports/adapters, RLS tenancy, authz, jobs/schedules, webhooks in and out, notifications,
  agreements/gates, the Simulator dev/demo harness, its screens and its half of the i18n catalog. You
  extend it; you don't edit it. (Its route wrappers necessarily stay in an app's `apps/<app>/src/app` — Next.js
  requires it.)
- **Two example apps.** `apps/showcase` — a support desk: tickets, escalations, attachments, two job kinds, two
  actors, six people — exists so every framework capability has a living worked example. Read it as
  the reference, then eject it. `apps/starter` — one entity, one card, two tenants, and a seam whose
  other eleven modules register nothing — is **the one you keep**. It is also the framework's second
  consumer, which is what makes the framework/app line falsifiable rather than merely asserted:
  anything SSSB reaches for that only exists because the showcase supplies it fails to compile there.
- **The repo scaffold**: the verify gate, lint fences, CI, docs doctrine. You keep it. The infra draft is
  no longer part of it: each app carries its own, `apps/<app>/infra/`, a stack holding SSSB's `SssbApp`
  construct (`packages/cdk`), so the starter you keep arrives with a deployment of its own.
  One rule in it reaches your own tests: a test that needs a scratch directory calls
  `makeTestTmpDir()` / `makeTestTmpDirAsync()` from `@sssb/tools/testing/tmp-dir` (`tests/support/tmp-dir.ts` re-exports it), never `mkdtemp` (lint
  bans it), and `test:unit`, `test:coverage` and `test:contract` run through
  `sssb check-tmpdir-leak`, which fails the run if a directory made that way survives it.

Apps live under `apps/` — one per product, each with its own `package.json`, configs and tests
(ADR-0007). Root commands that operate on ALL apps (`pnpm verify`, `pnpm typecheck`, `pnpm lint`,
`pnpm test:unit`, `pnpm test:e2e`, `pnpm build`, the demo-static trio) fan out with
`pnpm --filter './apps/*'`, so they pick up an added or renamed app with no edit. The commands that
must pick ONE app (`pnpm dev`, `pnpm tick`, `pnpm start`, and the showcase-only `pnpm ladle`, `pnpm build:demo`,
`pnpm dev:real`, `pnpm llm:record`) name an app, and `init-app` repoints or removes them for you.

## Fork and first boot

1. Fork/clone. **Take it with `git clone` or GitHub's Fork — not "Use this template" and not a ZIP**,
   because both of those give you a repository with no commit in common with SSSB, and
   `git merge upstream/main` then fails with `fatal: refusing to merge unrelated histories`. Updates
   here arrive by merge rather than by a version bump ([ADR-0013](adr/0013-upstream-updates-fork-and-merge.md)),
   so shared history is the mechanism, not a detail. If you already started from a template copy, you
   are not stuck — `git merge --allow-unrelated-histories upstream/main` once will graft the histories
   together and later merges behave normally, but that first one resolves as though every file were
   conflicting, so it is much cheaper to clone.
   Then `pnpm install && pnpm dev` — the app must boot seeded and offline in under two minutes.
   That hermetic boot is the repo's standing acceptance test; if it ever breaks, fix that first.
2. Run the demo tour ([runbooks/demo.md](runbooks/demo.md)) once. Fifteen minutes here saves days
   later: every capability you inherit is shown working, and Simulator is how you'll drive your own app
   in dev.
3. Then run `pnpm init-app`.

## `pnpm init-app`

```
pnpm init-app <slug> [options]        rename the app you keep
pnpm init-app --eject-showcase        delete the demo app (slug optional; both can run at once)
pnpm init-app --repo <name>           fill in the repository name on a tree adopted without it

  <slug>              the new APP_SLUG: lowercase letters, digits and dashes. Also becomes the app's
                      directory name and package name (the workspace root becomes <slug>-workspace,
                      so `pnpm --filter <slug>` can only ever mean the app).
  --name "<Name>"     display name for UI copy and titles (default: title-cased <slug>)
  --app <dir>         which directory under apps/ to rename (default: starter, else the only app)
  --repo <name>       the GitHub repository NAME this will live in: not the owner, and not the app slug
                      (an app can live in a repo of another name). Used in the advisory and discussions links of
                      SECURITY.md, the issue-template config and CODE_OF_CONDUCT.md. Without it those
                      links say PLACEHOLDER_GITHUB_REPO, next to PLACEHOLDER_GITHUB_OWNER, for you to replace
  --eject-showcase    remove apps/showcase and every reference to it
  --dry-run           print the plan and change nothing
  --yes               skip the confirmation prompt (required when stdin is not a terminal)
```

It refuses to touch anything without a `y` at the prompt, or an explicit `--yes`; `--dry-run` prints
the identical plan and writes nothing. It is **idempotent** — every edit replaces the value it found
in the tree rather than a value hard-coded in the script, so re-running it is a no-op, and it works
just as well on an app you already renamed once.

### The identity surface it covers

`APP_SLUG` (in the app's `apps/<app>/config/app.ts`) is the single source of MECHANICAL identity — session and
viewpoint cookies, the fake-auth JWT issuer, the service-token audience, webhook header names, CDK
stack/DB/budget/tags all derive from it. Other identifiers are deliberately NEUTRAL and never need
renaming (`APP_DATA_DIR`, the `app-simulator-*` browser keys, the `@app/*` workspace scope, and the
dev-server port key — see below). What is left is display copy, package naming, and the handful of
files that name the app's directory:

| Where                                                                                  | What                                                                                             |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `apps/<app>/config/app.ts`                                                             | `APP_SLUG`                                                                                       |
| `apps/<app>/package.json`                                                              | package `name` + `description`                                                                   |
| `apps/<app>/messages/en.json` + `es.json`                                              | `welcome.appName` (the header prop) and the `welcome.title`                                      |
| `apps/<app>/src/app/[locale]/layout.tsx`                                               | the document `metadata.title`                                                                    |
| `apps/<app>/src/demo-static/index.html`                                                | the static demo's `<title>`                                                                      |
| `package.json` (root)                                                                  | `name` (`<slug>-workspace`), `description`, `--filter` scripts                                   |
| `knip.json`, `vitest.config.ts`                                                        | the workspace key; the app list (`APPS`)                                                         |
| `apps/<app>/infra/package.json`                                                        | `name` (`<slug>-infra`); nothing else there names the app, which it reaches by `..`              |
| `apps/<app>/` itself                                                                   | the directory, renamed last                                                                      |
| `docs/`, `.claude/`, README, CLAUDE, CONTRIBUTING                                      | every backticked `apps/<app>/…` citation the path gate checks                                    |
| `CODEOWNERS`, `SECURITY.md`, `.github/ISSUE_TEMPLATE/config.yml`, `CODE_OF_CONDUCT.md` | the maintainer's handle and links → `PLACEHOLDER_GITHUB_OWNER` and `--repo` (or its placeholder) |

**The last row runs even on a rename-only adoption, with no `--eject-showcase`.** Those four files
route YOUR users to the TEMPLATE maintainer — a security report, a code-owner review, a conduct
complaint — and that is wrong the moment you fork, not only once you delete the showcase. `init-app`
rewrites `@jpslav` to `PLACEHOLDER_GITHUB_OWNER`, and the `github.com/safeinsights/sssb` advisory and
discussions links to `github.com/PLACEHOLDER_GITHUB_OWNER/<repo>`, and prints a "WHAT NOW NEEDS YOUR DETAILS" section naming
exactly what to fill in. Left as `PLACEHOLDER_GITHUB_OWNER`, `CODEOWNERS` names an account GitHub cannot
resolve, and turning on "require review from Code Owners" branch protection makes every PR unmergeable.
`LICENSE` and the `docs/adr/` approver lines are the two places the maintainer's name correctly
survives — the first because MIT requires the notice, the second because it is honest provenance for
SSSB's own decisions.

`tests/docs/adopter-identity.test.ts` ships with you and keeps guarding this, in a form that fits your
repo. In the template it runs `init-app` on a scratch copy and checks the result. In yours, where the
rewrite has already happened, it skips that half (you will see the skips) and runs one direct check: none
of those four files may name the template's maintainer. That is what turns red if a later
`git merge upstream/main` adds a line owned by `@jpslav` to your `CODEOWNERS`.

**`<repo>` is the repository's name, which is not the app's slug.** An app called `console` can live in
a repo called `pages`, and a link that says `…/console/security/advisories/new` 404s while looking
right. So pass the name you will push to: `pnpm init-app console --repo pages`. It takes the NAME only
— not `owner/name`, because the owner also fills `CODEOWNERS`, where it may be a team. Without `--repo`
the links say `PLACEHOLDER_GITHUB_REPO` beside the owner placeholder, and the closing output says so;
replace both (`git grep PLACEHOLDER_GITHUB -- CODEOWNERS SECURITY.md CODE_OF_CONDUCT.md .github` finds
them). Forgot it? Run `pnpm init-app --repo pages` afterwards: it replaces `PLACEHOLDER_GITHUB_REPO` in those
three files, whatever you have put for the owner by then, and does nothing else (no citation rewrite, no
`pnpm install` to run). On a tree `init-app` has not adopted yet it refuses, because it would scrub the
maintainer's identity and leave the rest. Once the links name a repository, a further `--repo` is reported
as ignored (the run says so rather than claiming a change), so edit the files directly then. `init-app` does not
read the name from `git remote`: at adoption time `origin` is often still the template, or a fork under
its default name, and a derived value would be plausible and wrong.

Filling in the owner and repository is necessary and not sufficient: **two of those links depend on repository
settings that are off by default.** `/security/advisories/new` resolves for a non-maintainer only once
**private vulnerability reporting** is on (Settings → Code security), and `/discussions` 404s until
**Discussions** is enabled (Settings → General → Features). Leave the first off and your security
policy names a private channel that does not exist, so the only route left is the public issue you
just told people not to open. Turn both on when you push, or delete the links you are not going to
honour.

The framework catalog holds NO product name at all: one shared catalog cannot name two products, so
`AppHeader` and `DemoShell` take a **required** `appName` prop and each app passes its own from its
`welcome.appName` key. That key is what `init-app` writes. It is required rather than optional because
the optional version shipped a bug: SSSB's catalog carried a `shell.appName` fallback, the showcase never
passed the prop, and every signed-in header in the demo rendered the fallback while the product called
itself Northwind Support. Nothing failed, because a default that resolves looks exactly like a default
that is right — and `sssb/no-jsx-literals`, the one rule that would have caught a raw string, cannot see
a translated key that is merely the wrong one.

**The port key keeps its old name, on purpose.** After `pnpm init-app acme`, the renamed app's
`package.json` still declares `"sssb": { "port": "starter" }`, its `playwright.config.ts` still calls
`originFor('starter')`, and the override is still `STARTER_PORT`. That reads oddly and is correct: the
keys in `@sssb/tools/ports` name a dev-server SLOT, not an app, and the app declares its slot in its own
`package.json` (its scripts call `sssb port`, which reads the declaration), which `init-app` keeps when it renames the app.
The declaration and the Playwright config that points at the server agree only because both spell the same literal. A
per-adopter rename would add two more files to the rewrite surface for no functional gain, and a
half-applied one produces two servers on two ports — silent wrong-app adoption, the exact failure that
whole module exists to prevent. Read `starter` as "the second slot", or set `STARTER_PORT` and forget it.

Nothing in that table is a literal an adopter has to hunt for, and no test hard-codes the product's
name: `apps/*/tests/catalog.ts` reads the app's own catalog and the specs assert against that. A rename
cannot break the gate.

### What `init-app` does NOT do

It prints this list when it finishes, because these are the parts that take judgement:

- **Deployment parameters** — `apps/<app>/config/params.ts`, which every app carries (the starter's is yours from the start).
  Every `PLACEHOLDER_` value, and `sentry.org`. Each maps to a cutover row.
- **The starter's content** — its seed world, its welcome copy, its one entity and its static-demo
  wiring are all still there and all still on screen. `init-app` renamed the app around them. The next
  section lists each one and what to do about it.
- **The cutover checklist** — [cutover-checklist.md](cutover-checklist.md) is yours: owners, dates, and
  the proof each row owes.
- **The demo size budget** — `apps/<app>/package.json`'s `check:demo-size` passes the static demo's byte
  budget. It is yours now. The starter ships it roomy on purpose, sized for an app's own screens and not as
  a pacing gate (it still fails on gross bloat); re-set it when you want a tighter gate, to what your app
  measures plus the headroom you want, in its own commit. `apps/<app>/DEMO-SIZE.md` beside it says what the
  number was set for and how it got there, and is where you record each change and why; it still calls the
  app by its template name, and that history is SSSB's and stays as written.
  `sssb check-demo-size` is SSSB's (`@sssb/tools`) and holds no number: the number lives in the app's
  `package.json`, so re-set it there. If you renamed the showcase
  instead (`--app showcase`), its number is its own pace-setting one, thin on purpose, and it has no
  `DEMO-SIZE.md`: SSSB keeps the showcase's history in `docs/decision-log.md`. When it goes red,
  the command's source (`packages/tools/src/commands/check-demo-size.js`, "WHEN IT GOES RED") says what to look at first.
- **The licence** — this template is MIT, which means the product you build on it is yours with no
  copyleft obligation. Your own product's licence is still a decision you make; nothing here makes it
  for you.
- **Prose.** `init-app` repoints path citations so the doc gate stays green, but the sentences around
  them still describe a template with two example apps. It prints the list of files to reread; README
  and `CLAUDE.md` are the two that matter, and `CLAUDE.md` is what teaches agent sessions your rules.

### The starter's content is still wired into your UI

A rename changes what the app is called, not what it shows. After `init-app`, four pieces of the
starter are still reachable by anyone who opens your app or your static demo:

| What survives                                    | Where it lives                                                                                                                                                                                                                                                                                                                                            | Where it shows                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| The seed world: two tenants, two teams, 3 people | `apps/<app>/src/seed/index.ts`                                                                                                                                                                                                                                                                                                                            | every sign-in picker (the app's, the static demo's, the Simulator's People tab); tenant themes |
| The welcome subtitle                             | `welcome.subtitle` in `apps/<app>/messages/en.json` + `es.json`                                                                                                                                                                                                                                                                                           | the app's root page AND the static demo's first screen — they share one component              |
| The Items slice                                  | `apps/<app>/src/components/items-card.tsx`, `apps/<app>/src/app/api/items/route.ts`, the dashboard route's `page.tsx` and `dashboard-glue.tsx` under `apps/<app>/src/app/`, the `Item` case in `apps/<app>/src/app-config/abilities.ts`, the table, migration and RLS proof under `apps/<app>/src/app-config/db/`, the `items` namespace in both catalogs | every signed-in person's dashboard                                                             |
| The static demo's composition root               | `apps/<app>/src/demo-static/app.tsx`                                                                                                                                                                                                                                                                                                                      | the whole `file://` demo: it passes `nav={null}`, the starter's welcome screen and Items card  |

None of it fails a gate, which is why it is listed here: a real adopter shipped a product demo that
opened on the starter's tenants and its Items card, four days after adopting. The team had been
looking at the product signed in as its own people, and nothing they used showed them the rest.

**Replace it; do not build beside it.** The seed world is one world, and the framework's pickers list
all of it — `@sssb/kit/seed/contracts` has no notion of a person who exists but is not offered. A product
world added NEXT TO `northwind` and `westgate` therefore puts both on every sign-in screen. Nothing in
`packages/kit` needs the starter's names: SSSB's own tests run against `packages/kit/test-fixture`.
What does read them by literal id is yours to change in the same commit:

- `apps/<app>/tests/e2e/items.spec.ts` signs in as `person-owner` and `person-other-tenant` and asserts
  the tenant names; `apps/<app>/tests/demo-static/static-shell.spec.ts` signs in as `person-owner` and
  `person-teammate` and asserts their names.
- `staffOrgSlug` in `apps/<app>/src/app-config/abilities.ts` must name a real seed org.

What the seed must keep is its SHAPE, not its content: the exports the framework reads through
`@sssb/app-config/seed` (`tenants`, `organizations`, `people`, `agreements`, `jobSchedules`, `findTenant`,
`findOrg` — `@sssb/kit/seed/contracts` types the data), at least one tenant and one person to sign in as,
and — if your deployment serves more than one tenant — two tenants, so that tenant isolation is something
you can see by using the app and not only in tests. WHERE it lives is yours.

**An app deployed one tenant per deployment may seed one tenant**
([ADR-0004](adr/0004-tenancy-rls.md), addendum of 2026-11-16), as long as the isolation proofs for your own
tables still use two. They always can: `apps/<app>/src/app-config/db/rls-proofs.ts` is handed two tenants and an
organization in each by the framework's proof runner, which creates them on every run and never reads your
seed. Drop the second tenant's sign-in and its cross-tenant assertions from the specs above in the same commit,
and keep the cross-tenant proofs. Nothing gates that last part — the RLS coverage check proves every table
is protected, not that your proofs exercise two tenants — so it is yours to keep honest.

**The Items slice is a worked example, so take what it teaches before you delete it.**
`apps/<app>/src/app-config/db/migrations/1001_items.ts` is a worked RLS migration — after an eject, the only one left — and its
section of `apps/<app>/src/app-config/db/rls-proofs.ts` is the proof that goes with it. Build your first real slice
from them (`/new-slice`), then remove Items the way "To remove a demo slice" below describes. There is
no flag that does this for you yet; `.claude/future-tasks/init-app-blank-option.md` carries the design.

**Wire the static demo last, and look at it.** A shell or a home screen you build in
`apps/<app>/src/components` reaches the real app through its route files and reaches the static demo
ONLY through `apps/<app>/src/demo-static/app.tsx` — the `nav`, `welcome` and `dashboard` props it hands
`DemoShell`. Being router-agnostic makes a component ABLE to run in the twin; it does not put it there.
When the sweep is done, run `pnpm build:demo-static`, open `apps/<app>/dist-demo/index.html`, and sign in as each seeded person.
That one look is the check: the picker, the first screen and the dashboard are exactly the three places
the starter survives.

### What ejecting the showcase costs

`apps/starter` already owns the two things that are not the demo and that were once the showcase's alone: the **RLS
contract suite** (`apps/<app>/tests/contract/rls-contract.test.ts`, one call of `contractSuite` from
`@sssb/kit/testing/contract`, which runs SSSB's composed proof suite on real Postgres, in a database of the app's own,
by a non-superuser owner as Aurora's master user is (twice: on a fresh server, and where `app_user` already exists),
by a superuser, and over the RDS Data API transport through its emulator: the anti-drift gate CI depends on; a check is
left out only by a named `optOut`, as in the conformance suite) and **`apps/<app>/config/params.ts`**. Run locally, the
suite starts its own Postgres with `embedded-postgres`, which the starter carries as a devDependency (an optional peer
of `@sssb/kit`); with `CONTRACT_DATABASE_URL` set it uses that server instead. So ejecting rescues nothing and deletes no gate:
`pnpm test:contract` runs your app's suite, and `tests/tooling/app-scaffold.test.ts` fails if an app registers
migrations without one, or the apps' params carry different keys (each `apps/<app>/infra/` hands its own to the same
`SssbApp` construct, which reads the same keys from every app).

Five root scripts are dropped, because the starter does not ship the capabilities behind them:
`dev:real`, `llm:record`, `ladle`, `build:demo`, `start:demo`. They come back with the thing they
drive — a Sentry/params-wired `next.config.ts` and a real-mode preflight for `dev:real`, an
`@sssb/app-config/assistant` registration for `llm:record`, `@ladle/react` plus a `.ladle/` config for the
workshop, Panda codegen for the demo build. Copy each from the showcase **before** you eject if you
want it.

One gate is relaxed on the way out. SSSB's knip workspace carries `includeEntryExports: true`, which
means "every symbol SSSB PUBLISHES must have a consumer" — an invariant the showcase made true by using
nearly all of it. A one-entity app does not: `apps/starter` imports 35 of SSSB's 138 published subpaths from its source (39
counting its tests), so the same setting would start demanding you delete the other 103 — capabilities you merely have not
reached yet, not dead code. `--eject-showcase` therefore turns it off. knip keeps reporting unused
files, and the declared `exports` surface goes back to being what it is without a rich consumer: a
declaration.

**What ejecting does NOT cost you is the gate.** SSSB's own suite used to be welded to the demo's
vocabulary — its seed slugs, its `tickets` table, its `export-tickets` job kind, its route tree — so
deleting the demo took `pnpm test:unit` and `pnpm typecheck` down with it. The framework now carries a
seam of its own, `packages/kit/test-fixture`: a conforming `@sssb/app-config/*` registration with its own
two-tenant seed world, one table and its migrations, one job/webhook/notification kind, an inbound handler,
and a route tree that exists only to be read by the authorization scan. The root TypeScript program
resolves `@sssb/app-config/*` there, and `vitest.config.ts` runs SSSB's suite in a `kit` project pointed at
it. Nothing in that fixture is deletable by adoption, and its vocabulary is deliberately none of the
apps' — so a framework test that reacquires a dependency on YOUR world fails loudly instead of passing
by coincidence. `pnpm verify` is green on a freshly ejected repo, end to end.

The one thing that DOES stay app-shaped is the conformance suite, `@sssb/kit/testing` — the authorization scan of
your route tree, the i18n partition/parity checks, the pglite RLS suite, migration order, the demo-presets check and
the seam map — which your app runs from its own tree: `apps/<app>/src/sssb.conformance.test.ts` calls
`conformanceSuite({ appDir, optOut })`, against your catalog, your tables, your routes and your presets. Leaving a
check out takes a named opt-out with a reason (the check ids are in `@sssb/kit/testing/checks.json`); a typo in one
fails the run, and so does a check that is skipped without one. That is what stops the fixture becoming the only world
the framework is ever proved against.

Two `sssb` commands guard that suite and the install around it, and `pnpm verify` and CI run both (`pnpm sssb:doctor`,
`pnpm check:e2e`; the scripts are `sssb:doctor` and `check:e2e` because `pnpm doctor` is pnpm's own command).
**`sssb doctor`** checks every app of the workspace in one run. It asks `vitest list` what would actually run with the
config a bare `vitest` would load for each app (the root's `vitest.config.*` when it runs the app's unit tests,
else the one Vitest finds walking up from the app, its own or the root's, else Vitest's defaults), and fails naming
every unit conformance test that would not, unless its check is opted out by name in the app's own
`apps/<app>/src/sssb.conformance.test.ts`; some config that runs your `apps/<app>/tests/contract/` files must list
every contract check. So an `.only` beside the suite, a `testNamePattern` in that config, or a config that stops
picking the file up is red before it silently drops a check (a `-t` a CI step adds is not doctor's to see: the suite
fails a run that drops only some of its checks, and a filter that drops all of them leaves the file skipped). Any other
Vitest config (a browser, integration or CI config) that runs some of an app's tests but not the suite is reported, not
failed, and so is a bare `vitest` from the app's own directory (what the app's scripts and `pnpm -r` run) when the main
run is the root's and that one would not run the suite, even if it runs none of the app's tests; so are the narrowing
flags your package.json scripts pass to vitest and which script runs each contract config: doctor cannot see which config or flags your CI uses, so make
sure CI runs the config doctor names. It also fails a second copy of any peer `@sssb/kit` declares (React, Next,
Kysely...), an importer of the framework anywhere in the workspace that does not run on its own seam, and an
`@sssb/*` package out of step with the framework's version, and it reports framework cutover rows your
`docs/cutover-checklist.md` never mentions. Inside SSSB's own repository it says "in-repo mode" and checks each app's
seam aliases instead of links. **`sssb check-e2e`** asks your own Playwright which files your configs load
(`playwright test --list`, which starts no server and needs no browser), bundles each, and fails, naming spec and
framework file, if a spec reaches the framework other than through `@sssb/kit/testing/e2e`, the one entry Node can
load; reaching it through your own domain module or a workspace package counts. A spec that reaches the framework's
TypeScript stops Playwright listing its config at all (Node will not load TypeScript under `node_modules`), so
check-e2e then fails the config with Playwright's error and names the framework file. A config Playwright cannot list,
or that lists no test, fails too; a config kept outside the app's directory is named with `--config <file>`.

## Layout

```
packages/kit/src/            the framework — never edit for product work
packages/kit/test-fixture/   the framework's OWN app seam, for its OWN tests — not yours, not shipped
apps/<app>/config/            APP_SLUG and (optionally) deployment params
apps/<app>/src/app/           Next route files (thin wrappers; framework routes live here too)
apps/<app>/src/app-config/    THE SEAM — your registrations
apps/<app>/src/components/    your screens/cards
apps/<app>/src/domain/        your domain modules
apps/<app>/src/ports/         your own ports, for a vendor SSSB has no port for (docs/recipes/app-owned-adapter.md)
apps/<app>/src/adapters/      their registry and fakes; adapters/real/ is the app's only vendor-SDK directory
apps/<app>/src/demo-static/   your half of the file:// demo twin (the framework half is SSSB's)
apps/<app>/src/seed/          your seed world (fills in @sssb/kit/seed/contracts)
apps/<app>/messages/          your i18n namespaces (the framework ships its own catalog)
apps/<app>/tests/             your e2e, static-demo and contract specs
```

### What you may import from SSSB

`packages/kit/package.json`'s `exports` map is the contract: it lists the 138 subpaths your app may
import as `@sssb/kit/<subpath>` (`@sssb/kit/ports/db`, `@sssb/kit/components/app-header`, `@sssb/kit/db/with-tenant`). The
other 62 modules of the package are internals — private sub-components, the fake-db plumbing, the test helpers, the
framework migrations, the real adapters the registry constructs for you, the authorization scan's
analyser — and importing one fails
`pnpm lint` with the rule `sssb/public-surface`, which reads that map directly. Your Playwright specs may import
less: Node loads a spec without your seam and without compiling anything under `node_modules`, so a spec reaches
SSSB only through `@sssb/kit/testing/e2e`, which ships compiled and seam-free (today, the webhook signature
verifier). A spec that needs one of your app's constants reads it from a module that imports nothing from SSSB
but types, as the showcase's pagination spec reads `apps/showcase/src/domain/ticket-page-size.ts`. If you find yourself
reaching for an internal, that is a signal the capability needs a seam, not a wider fence; if a module
really is part of the contract and merely has no importer yet, that is an SSSB change: add the line upstream
(ADR-0013, "Sending an SSSB fix back upstream") and take it back by merge, because in your fork the map is a
conflict on every later update.

One call site reaches SSSB by file path instead of by subpath, because its tool needs a file rather
than a module specifier, and it is the one to remember if you move things: each app's
`next.config.ts` points next-intl at `packages/kit/src/i18n/request.ts`. The migrator Lambda used to be the
second; the `SssbApp` construct (`packages/cdk`) now resolves it as `@sssb/kit/adapters/real/migrate-handler`
from the app's own directory, and passes the app's seam to esbuild explicitly. Nothing typechecks
`apps/<app>/infra/`; its `synth` is its check.

### When a lint fence must let one of your modules through

Some fences take named exceptions. Today one does: `sssb/no-raw-db-handle`, which bans `getDb()` in every
module of your app (tenant-scoped data goes through `db.withTenant()`, ADR-0004). If a module of yours truly
needs the raw client, say a maintenance job that runs as the system across every tenant, list it in your app's
own `apps/<app>/lint-exceptions.mjs`. Don't edit SSSB's `eslint.config.mjs` or the fences in
`packages/eslint-plugin`: every later SSSB update to them would conflict with your edit, and a path you wrote there
names your app's directory, which `pnpm init-app` renames without rewriting those files.

```js
// apps/<app>/lint-exceptions.mjs
export default {
    'sssb/no-raw-db-handle': [
        { file: 'src/domain/maintenance.ts', reason: 'purges every tenant’s expired rows as the system' },
    ],
}
```

The app preset of `@sssb/eslint-plugin` (`configs.app({ root })`, which `eslint.config.mjs` applies to every app)
reads the file when the config loads. Each entry names one existing file under
`apps/<app>/src`, by a path relative to the app, and gives a reason. A glob, a directory, a path out of the
app, a missing reason, or a file that no longer exists fails `pnpm lint` itself, naming the entry. So an
exception cannot quietly widen, and cannot outlive the file it names; one that outlives its need (the module
stopped using the raw client) is still yours to delete. Every other module stays banned. ESLint reads the
file when it loads its config, so restart your editor's ESLint server after you edit it.

**A vendor SDK your app owns an adapter for** (`docs/recipes/app-owned-adapter.md`) is added to the vendor ban by
your app, not by editing SSSB's list: name it in your app's `package.json`, `"sssb": { "vendors": ["stripe",
"stripe/*"] }`, in the gitignore-style patterns SSSB's own list uses. The preset reads it, and so does
`checkFences`, which compares the vendor rules' options with it exactly. A pattern that starts with `!` is refused:
your list adds to SSSB's and cannot take a vendor off it.

**Every fence is a rule with an id of its own**, so a `no-restricted-imports` or `no-restricted-syntax` block of
your own, after the preset, adds your bans without replacing SSSB's. What can still switch a fence off (turning an
`sssb/*` rule off or down, an `ignores` that drops a directory, a nested config file, an `eslint-disable` comment
that names a fence or no rule at all) is what `checkFences` from `@sssb/eslint-plugin/check-fences` reports: it
compares your app's effective config with the preset's for every source file, and lints probe files through it.

## Building your product — everything registers through `apps/<app>/src/app-config/`

The framework never imports your code directly; it imports the registration seam (`@sssb/app-config/*`), and
a lint fence enforces the direction. Each module there is the app-side half of one capability. The
"empty" column is what `apps/starter` registers — read it as the off switch for that capability:

| Seam module                                   | You register                                                                                       | Empty looks like                           |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `abilities.ts`                                | subject types + staff org + credential kinds + person and machine (`appMachineAbilityRules`) rules | (starter registers one)                    |
| `db/schema.ts`, `db/migrations/`              | your tables (`AppTables`) + migrations named `NNNN_name`, four digits, numbered ≥ 1001             | (starter registers one)                    |
| `db/rls-proofs.ts`                            | tenant-isolation proofs for those tables                                                           | an empty async body                        |
| `jobs.ts`                                     | your background job kinds + handlers                                                               | `[] as const`, `{}`                        |
| `digest.ts`                                   | the rows the framework's scheduled digest summarizes                                               | `async () => []`                           |
| `actors.ts`                                   | your simulated counterparties for dev/demo                                                         | `actors = []`, `type ActorId = never`      |
| `simulator.ts`                                | your extra Simulator tabs + feature flags                                                          | `flags = []`                               |
| `presets.ts`                                  | demo presets (`/new-preset`): starting worlds every host can load, and your own kinds' definitions | `presets = []`, `appPresetOperations = []` |
| `preset-operations.ts`                        | server halves of your own preset operation kinds (`/new-preset-operation`)                         | `{}`                                       |
| `tours.ts`                                    | scripted Simulator walkthroughs of your product                                                    | `tours = []` (no Tours tab)                |
| `notifications.ts`, `webhooks.ts`, `audit.ts` | your event vocabularies                                                                            | `[] as const` / `never`                    |
| `inbound-email.ts`                            | your `<org>+<slug>@domain` email handlers                                                          | `{}`                                       |
| `assistant.ts`                                | your LLM tools + system prompt                                                                     | omit the module and its route              |
| `messages.ts`                                 | your i18n namespaces + catalog loader (partitioned)                                                | (every app registers some)                 |
| `identity.ts`                                 | `APP_SLUG`, re-exported from the app's app config                                                  | (every app registers it)                   |
| `seed.ts`                                     | your seed data re-export                                                                           | (every app registers it)                   |

The one place an empty registration is not free: `AppSubjectFields` in `abilities.ts` must be an
`interface` (the framework's `AbilitySubject` extends it), and an app with no extra subject fields
therefore declares an empty one and suppresses `@typescript-eslint/no-empty-object-type` on that line.
`apps/starter` shows the suppression and why.

**To add a feature slice**: run `/new-slice` (and the per-capability scaffolds `/new-entity`,
`/new-job`, `/new-actor`, `/new-notification-kind`, `/new-webhook-event`, `/new-tour`, `/new-preset`, `/new-preset-operation`). Each walks the house way:
screen in your app's `apps/<app>/src/components` (yours) or `packages/kit/src/components` (framework-generic),
thin route, seam registrations, an RLS migration copied from the reference
(`apps/starter/src/app-config/db/migrations/1001_items.ts`), colocated tests, e2e, then `pnpm verify` +
`pnpm test:contract`.

**To remove a demo slice** (if you keep the showcase around for a while): delete its card + routes +
`apps/<app>/src/domain/` module + seam entries (ability case, table, migration, message namespace, vocabulary
entries) and its e2e specs, then update the static twin (`apps/<app>/src/demo-static/app.tsx`) and run the full
gate. Tickets is the most-wired example (assistant tool, export job, inbound handler all reference it)
— replace those seam entries together. An unused framework capability needs nothing: an empty
registration is the off switch.

**Static demo parity**: every slice ships its in-memory twin so the single-file `file://` demo keeps
walking end-to-end. You only write your DOMAIN half — `apps/<app>/src/demo-static/app.tsx` is a
composition root that adds your rows and cards to the framework world `@sssb/kit/demo-static` already
simulates (people, mail, jobs, schedules, webhooks, notifications, agreements, audit, snapshots). For one
table that is 74 lines; the showcase's, with three entities plus actors and the assistant, is 669.
Budget-gated per app (`pnpm check:demo-size`, each app passing its own byte budget). The starter's is
the number you inherit, sized for YOUR growth (room to grow to the showcase's size), and it is yours to
re-set in `apps/<app>/package.json`, with the reason recorded in `apps/<app>/DEMO-SIZE.md` beside it; the
source of `sssb check-demo-size` (`packages/tools/src/commands/check-demo-size.js`, SSSB's, never yours to edit) says what it guards and what to do when
it goes red. The demo's build also drops every Mantine style rule no shipped component can
match (`packages/tools/src/prune-mantine-css.js`, inside the `@sssb/tools/vite` preset), so a Mantine component you add needs no CSS import. The same file is
the ONLY door for your shell, too: the `nav`, `welcome` and `dashboard` it passes `DemoShell` are what
the demo shows, so a navigation you build for the real app is absent from the twin until you pass it
there.

**How a second app keeps the seam honest**: `apps/starter/tsconfig.json` includes the whole of
`packages/kit/src` (minus tests and stories), so `pnpm typecheck` compiles the ENTIRE framework
against the starter's registrations — a framework module that assumed the showcase's tables or
vocabulary fails there and nowhere else. `apps/starter/src/sssb.conformance.test.ts` then runs SSSB's
conformance suite a second time, under the starter's aliases. Each check was watched failing before being trusted.

### The scheduled tick

SSSB's recurring work only advances when something ticks it. `job_schedules` (a digest, a reminder) and outbound
webhook retries are drained by one function, `runScheduledTick` (`@sssb/kit/server-lib/scheduled-tick`), and the route
that calls it lives in the app you keep: `apps/<app>/src/app/api/webhooks/cron/route.ts`,
`export const POST = withWebhookSecret(…)`. `init-app` moves it with the rest of the app and nothing deletes it;
the showcase carries the same route over the same function.

- **Who may call it** is a machine, not a person. The route is guarded by the shared webhook secret
  (`Authorization: Bearer …`, compared in constant time; anything else is an opaque 401 before the tick runs). The
  authorization scan (the conformance suite's `authz-mutations` check) exempts a `webhooks/` route only if its handler
  is the `withWebhookSecret(…)` call, so if you edit the route keep that wrapper, and keep the logic in SSSB's function.
- **In a deployment** nothing calls it until you set up the scheduler: that is the `scheduled-tick` row of the
  [cutover checklist](cutover-checklist.md).
- **In `pnpm dev`** nothing ticks it unless you ask. The dev server runs no scheduler, and the starter's server app has
  no Simulator panel (its `file://` demo has one, in the browser; the showcase's server app has one too, and its Jobs
  tab advances the world clock and runs what is due). Three ways to ask:
    - **`pnpm tick`** calls the running dev server's route once and prints what ran (`pnpm tick:starter` for the starter
      beside the showcase; once `init-app` has ejected the showcase, `pnpm tick` is your app). It exits 1 if the server is
      down, rejects the secret or answers an error, and 2 for a bad command line. It authenticates as any caller must: it
      reads the per-checkout dev secret from `apps/<app>/.data/auth/webhook-secret` (the first request to a server creates
      the file, so a missing one is made that way) and sends it as the bearer. It adds nothing to the route and cannot
      reach a server that is not on this machine (`--url` takes only `localhost`, `127.0.0.1` or `[::1]`). A server in
      real mode checks `WEBHOOK_SECRET` and never reads that file, so `pnpm dev:real` is not something it ticks.
    - **`DEV_TICK_SECONDS=30 pnpm dev`** also runs that call every 30 seconds while the server is up (any whole number
      of seconds, 1 to 86400). It says nothing while nothing is due, and speaks when a job was spawned, a delivery moved, or
      the server stopped answering. It is **off unless you set the variable**: the Simulator controls the world clock in a
      demo, the e2e suites expect a scheduler that does nothing until a test asks, and hermetic dev does not do work nobody
      asked for. The e2e servers are started with the variable blanked, and a ticker asked for while `E2E_BUILD` or
      `DEMO_MODE` is set is refused. While a ticker runs it leaves `apps/<app>/.data/dev-ticker.json`, and the playwright
      configs refuse to load while its process is alive, because Playwright adopts a dev server already on the app's port
      and that one would still be ticking: stop it before `pnpm test:e2e`. (A wrapper that was killed outright leaves a
      stale marker; one whose process is gone is ignored.)
    - **The showcase's Simulator** (Jobs tab, "Scheduler ticker") starts and stops the same ticker inside the dev server,
      with the interval in a field: the same call, the same marker under the server's pid, the same off-until-asked rule.
      It exists only on a `pnpm dev` of a simulated world: its route
      (`apps/showcase/src/app/api/simulator/ticker/route.ts`) answers 404 in real mode and in every production build (a
      deployment, the hosted demo, the e2e build), and the panel shows the control only where the route answers. The
      static demo has no server and never wires it. It will not start beside a ticker started outside it (`DEV_TICK_SECONDS`); it says
      that one is running and leaves it to be stopped where it was started. The starter has no server-side Simulator, so
      it has no such control; the route is app code, and an app that wants one copies it.

    The answer is `{"ok":true,"spawned":0,"failed":0,"deliveries":{…}}`, which `pnpm tick` prints as one line. In a
    simulated world "now" is the Simulator's world clock (real time plus whatever offset a demo advanced), so a tick
    honours a clock a demo moved. A schedule whose spawn failed, or a delivery that failed, shows in that line and is
    retried by the next tick: the tick itself succeeded, so the exit code stays 0.

## Cutover — from hermetic to real

Everything needing credentials, accounts or money is a row in
[cutover-checklist.md](cutover-checklist.md) — **that file is yours**, pre-filled with the rows
essentially every instance needs and waiting for your owners and dates. The pattern:

> **Row** = item name · what it is · what unlocks it · the exact verification that was deferred.

The last column is the one that matters. Until a row's proof is met, the related real adapter is
_authored but unverified_ — it compiles, it has a fake that everything else runs on, and nobody has ever
watched it talk to the real thing. Keep the discipline when you add rows: **name the proof, not just the
task.** "Set up email" is a task; "a real send through the email port with DKIM/SPF verified on the
domain" is a proof.

The file opens with a worked row — closed, dated, owned, with a proof column that was thought through
rather than restated. Read it once for the level of detail each row deserves before you fill in your own.

**SSSB needs Postgres 16 or later.** Framework migration
`packages/kit/src/db/migrations/0015_app_user_grant.ts` lets the migrating role switch to `app_user`
with `GRANT … WITH SET TRUE`, checked by `pg_has_role(…, 'SET')`. Both arrived in Postgres 16, so on an
older server that migration cannot run. Everything SSSB targets already meets it: the Aurora cluster in
`packages/cdk/src/sssb-app.js` (16.10), CI's contract job (`postgres:16` in `.github/workflows/app-checks.yml`), pglite
(18.6) and the embedded Postgres that a local `pnpm test:contract` starts (18.4).

## Staying current with SSSB

Adopting is a fork, not a dependency: SSSB ships as a workspace package inside the repo you took, so
upstream improvements reach you through `git merge`, not `pnpm update`.
[ADR-0013](adr/0013-upstream-updates-fork-and-merge.md) records why, and the exact
`git remote add upstream` workflow — including which directories reliably conflict and what would make
publishing to a registry worth the versioning cost.

### When an update changes what your seam must say

A merge from SSSB can make your app stop compiling, or fail the authorize scan, until you add a line. These come from the change that
let non-session callers reach `authorize()` (ADR-0012, 2026-11-16 addendum):

- `apps/<app>/src/app-config/abilities.ts` must export `AppPersonCredentialKind` and
  `AppMachineCredentialKind` (types), plus `appMachineAbilityRules` and `nonSessionAdministration`
  (values). `never`, `return false` and `{}` opt out.
- An `AbilityActor` literal whose `manageAll` may be true must state its session:
  `credential: { kind: 'session', id: null }`. Without it the literal no longer compiles, because only a
  stated session wields `manageAll`. A literal with `manageAll: false` needs nothing, but without a
  session credential it can no longer take a session-only action (inviting a member, changing the org,
  managing a webhook endpoint, accepting terms).
- `abilityActorFromCredential` takes an `OrgIdentity`, and only `orgIdentityForSlug` (`@sssb/kit/db/org-lookup`)
  makes one: a hand-paired `{ id, slug }` no longer compiles.
- A mutating route under `api/service/` must call `authorize(...)` with the actor `withServiceCaller`
  passes. The scan's message says how.

## Keeping the docs honest

The doc set is mapped in [docs/README.md](README.md), which splits it three ways: doctrine (binding, and
**gated** — `tests/docs/doc-paths.test.ts` fails the build if a doctrine doc cites a path that does not
exist), dated records, and future tasks. Three consequences for you:

- **The records (`docs/decision-log.md`, `docs/build-notes.md`) are the template's, not yours.** They are
  append-only, so nothing rewrites them; keep appending your own entries below the inherited ones, or
  truncate them at the date you forked and keep the habit. `build-notes.md` in particular earns its keep
  the first time something behaves strangely.
- **`.claude/future-tasks/`** carries designed-but-unbuilt work with the design written down. Keep the
  ones you want, delete the rest.
- **Docs that arrive by `git merge upstream/main`** may cite `apps/showcase` or `apps/starter`, which you
  no longer have. The gate passes those, since they name SSSB's reference apps, and still checks every citation
  of your own app and of SSSB. (It used to fail on them.)

The habits that keep the rest truthful, which you inherit: record unplanned decisions in
`decision-log.md` and hard-won lessons in `build-notes.md` as they happen; amend an ADR by appending a
dated addendum, never by editing what it said; run the `doc-steward` agent on every branch diff before a
PR; `/pre-pr` runs the verify gate plus a branch review. `CLAUDE.md` teaches all of this to agent
sessions — keep it current as your product diverges.
