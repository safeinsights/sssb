# SSSB — maintainer guide

@packages/kit/src/guide.md

The import above is the app guide, the rules every app on SSSB follows, as `@sssb/kit` ships it (`@sssb/kit/guide.md`;
an adopter's workspace imports the stamped copy `sssb guide` writes). In this repository it holds for BOTH apps,
`apps/showcase` and `apps/starter`, and its paths are relative to each app's directory.
This file is the other half: what holds for SSSB's own repository, where the framework, the fixture, the packages, the
release and the gates are made. Nothing the guide says is repeated here. An app-facing rule an adopter needs goes in
`packages/kit/src/guide.md`, never here: it ships, so it takes a changeset (`.changeset/README.md`), and the doc gate
checks its paths against `apps/starter`.

Multi-tenant web app foundation, built to be adopted: `docs/adopting.md` is the adopter guide; keep it truthful.
Architecture decisions are recorded in `docs/adr/`. Follow the Accepted ones (0001–0014) and don't relitigate them;
0014 is a plan carried out in steps (its implementation plan), so until a step lands, the tree and the docs
describe what is built, not what 0014 will build.
The philosophy behind these rules — thin slices, ports/adapters, hermetic dev, demo mode, one-app default —
is `docs/development-approach.md`; read it to understand the why, not just the what.
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
  tables or vocabulary fails to build). A change to the kit is not done until BOTH apps are green. Inside
  `packages/kit` the fence bans the app's `@/*` alias, `@app/seed`, a relative or absolute path (or `file:` URL) that lands in `apps/` or
  `packages/seed`, a `..` in any package or alias specifier, and any specifier through `node_modules`, by
  `import()` and in a type `import('…')` as well as in a declaration; the `@sssb/app-config/*` alias is the only
  channel back. `sssb/no-path-out-of-package` also bars any path out of `packages/kit`, an absolute path or `file:`
  URL even into it, and a shipped file's path to one the `files` allowlist leaves out, with no exceptions.
  **The framework must compile under `packages/kit/tsconfig.strict.json`**
  (the strict-flag set at the ES2022 lib floor; `pnpm typecheck` runs it), because adopters compile the shipped
  `.ts` under their own options. **`@sssb/kit`'s `files` allowlist in its `package.json` decides what ships**
  (tests and stories out; the conformance suite ships as source, `@sssb/kit/testing`); a new file that must ship, or a new import of a
  package the source needs, goes in the manifest — pack and consume checks the tarball. A package the app must
  share one copy of is a peer: `react`, `next`, `next-intl`, `@mantine/core`, `kysely` (the app's migrations get
  the framework's `Kysely`), the compiler and the global types an adopter's program shares (`typescript`,
  `@types/react`, `@types/node`), `vitest`, optional, for the shipped tests, and `embedded-postgres`, optional, for the
  contract runner's local server; anything else, `@types/pg`
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
  deleting the showcase with a red gate.
- **`@sssb/kit`'s public surface is `packages/kit/package.json`'s `exports` map** — 139 published subpaths
  (its `exports` keys minus `.` and `./package.json`; count it, never remember it). Lint-enforced
  (`sssb/public-surface`, which reads that map, so the map is the only list). Adding a module does NOT
  publish it; add the `exports` line deliberately, and never widen the map to silence the rule.
- **Vendor SDKs in the framework** go only in `packages/kit/src/adapters/`, for SSSB's ports; an app's go in its own
  `adapters/real/` (the guide). Lint-enforced (`tests/lint/app-owned-adapters.test.ts`), with `process.env` banned in
  `packages/kit/src` too, bar the per-file exemptions `eslint.config.mjs` names. That an app's registry uses
  `isSimulated` is convention: lint cannot follow a value. An app's own vendor goes in its `package.json`
  (`sssb.vendors`), never SSSB's list.
- **The lint fences are `@sssb/eslint-plugin`** (`packages/eslint-plugin`, ADR-0014 P6): ONE plugin object
  with every `sssb/*` rule, internal ones included. **Every fence is a rule with an id of its own**, never a
  `no-restricted-imports` or `no-restricted-syntax` setting, which a later config block REPLACES for the files it
  matches (the merge trap). Both apps get exactly what an adopter's app gets, `configs.app({ root })` (the root
  `eslint.config.mjs` passes `apps/*`); that file adds the framework's and the other packages' blocks,
  plus repo-wide ones that reach the apps too (`sssb/public-surface`, `sssb/no-direct-mkdtemp` over every
  `*.test.{ts,tsx}`). A rule that needs this repo's
  files takes `{ root }` and reads it when it runs, never when the plugin loads. A new app-side fence goes in the
  preset AND in `packages/eslint-plugin/src/probes.js`, which `sssb check-fences` lints through an app's composed
  config, with an effective-config comparison against the preset for every source file;
  `tests/lint/check-fences.test.ts` runs it on both apps and on scratch apps that weaken a fence.
- **`@sssb/tools` (`packages/tools`) is SSSB's tooling: the `sssb` CLI, the Next, Vite and Vitest presets, the
  tsconfig base the apps extend, and helpers** (ADR-0014 P4). It is plain JavaScript that Node loads directly
  (`// @ts-check`, a hand-written `.d.ts` beside each export, checked by the root `tsc`), and it has **no dependency on
  `@sssb/kit`** (rule 4): it reaches the framework only through `packages/tools/src/kit.js`, which resolves
  `@sssb/kit` from the APP's directory and checks the real path of what it got. `sssb/no-bare-kit-import` bans a bare
  `@sssb/kit` specifier in every package under `packages/` but the framework and the showcase's seed. A preset loads
  the tools it configures (Vite's React plugin, next-intl's plugin, jest-dom) from the app, never its own copies. A
  new CLI command is a module in `packages/tools/src/commands/` plus one entry in `bin/sssb.js`'s `COMMANDS`; a new published
  helper is an `exports` entry with its `.d.ts`. Pack and consume packs it beside the framework.
- **`@sssb/create` (`packages/create`) is the generator** (ADR-0014 P12): `pnpm create @sssb <dir>` runs its bin,
  `sssb-create`. Plain JavaScript with no dependencies at all, SSSB's packages included (rule 4), because it runs
  before anything is installed. **Its template is the files git tracks in `apps/starter`**, copied from the working
  tree (`buildTemplate` in `packages/create/src/template.js`): **`git add` a new starter file** before a pack or the
  create tests see it. `prepack` writes a gitignored `template/` beside the bin and `postpack` removes it (never
  commit it); packing refuses a `HEAD` that no remote-tracking branch of `safeinsights/sssb` holds, and an
  `apps/starter`, `packages/kit/src/guide.md` or plugin (`.claude-plugin/marketplace.json`, `plugins/sssb`) that differs
  from `HEAD`, unless `SSSB_CREATE_UNPUSHED_PIN=1` (pack and consume sets it, but on a push to `safeinsights/sssb`). Run
  from a checkout, the bin builds the template into a temporary directory first and only warns about the pin; the tests
  call `buildTemplate` themselves. The
  workspace around the app is written by `packages/create/src/files.js`, its `.claude/settings.json` (the plugin's
  marketplace pinned at the workflow's commit) and `CLAUDE.md` included; a root file that names nothing of this
  repository's can be copied instead (`ROOT_FILES` in `packages/create/src/template.js`). Running it by hand:
  `node packages/create/bin/create.js <dir> --sssb <dir of packed tarballs>` (`docs/adopting.md`).
- **`@sssb/kit` stamps the commit it is packed from** into `dist/release.json` (its `prepack`,
  `packages/kit/scripts/stamp-release.mjs`), refusing shipped sources that differ from it under the same switch.
  `sssb doctor` reports, never fails, a workflow or marketplace pin that is not that commit, or a pinned marketplace no
  plugin is enabled from; `release.mjs candidate`
  refuses a candidate whose kit names another. In-repo there is no stamp: the kit is source.
- **`@sssb/kit/core` is pure TypeScript** — no framework imports, and no JSX (it compiles to an import of
  `react/jsx-runtime`). Lint-enforced.
- **Framework screens live in `packages/kit/src/components`**, router-agnostic like the apps' (the guide), and the
  framework's catalog namespaces in `packages/kit/src/i18n/messages/{en,es}.json`, deep-merged with each app's at every
  load site.
- **Each app's `apps/<app>/config/params.ts` holds the same keys** (`tests/tooling/app-scaffold.test.ts` fails a
  drift), its placeholders tracked in the cutover checklist (`docs/cutover-checklist.md`).

## Workflow

- **`pnpm verify`** here runs typecheck + lint + unit + knip + `sssb doctor` + `sssb check-e2e` in parallel, then e2e,
  static-demo build, demo size budget, static-demo e2e. E2E needs Playwright chromium installed
  once: `pnpm exec playwright install chromium`. **`sssb doctor`** (`pnpm sssb:doctor`, or `pnpm exec sssb doctor` from the root: one run checks
  every app, starting from the first when the root takes no `@sssb/kit`; never `pnpm doctor`, which is pnpm's own) fails unless the config a bare `vitest` would load for each app
  lists every unit conformance test, and some config running its `apps/<app>/tests/contract/` lists every contract
  one, less named opt-outs; and on a pnpm `nodeLinker` other than `isolated` or a leftover `.pnp.cjs` (first, alone: nothing else is checked), a
  second copy of a kit peer, an @sssb package out of step, a workspace walk that
  misses the app, or (in this repo, "in-repo mode") a tsconfig or Vitest alias sending an app's seam anywhere but its
  own. Any other Vitest config that runs an app's tests without the checks, a bare `vitest` from the app's directory
  that would not run the suite, and the flags package.json scripts pass to vitest, are reported, not failed: doctor
  cannot see what CI runs. In-repo it checks no guide copy (this file imports the source) and no pins (no stamp).
  **`sssb check-e2e`** (`pnpm check:e2e`, per app) asks
  Playwright which files each config loads, and fails a spec that reaches the kit other than through
  `@sssb/kit/testing/e2e`, directly or through an app module or a workspace package.
- `pnpm verify` does NOT run `test:contract`, jscpd, coverage, gitleaks, the licence scan or pack and consume — CI runs those
  (`.github/workflows/checks.yml`). **CI's app checks are the reusable workflow an adopter calls**
  (`.github/workflows/app-checks.yml`, ADR-0014 P10): `checks.yml`'s `sssb` job calls it (by its local path), so
  its checks are named `sssb / <job>` (`sssb / all-checks` fails unless every one ran and passed), and each job's
  work is one `pnpm exec sssb ci <job>`. A job renamed or added there changes a required check's name: the rulesets
  on `main` and `integration` require them by name, and `tests/tooling/app-checks-workflow.test.ts` pins the names. **Pack and consume** (`pnpm pack-and-consume [--shape pages|generated]`, ADR-0014 P2 and
  P12) packs every `@sssb` package flat into one directory, generates workspaces outside this repo with the PACKED
  `@sssb/create` against those tarballs, and checks them: `pages` (CI's `pack-and-consume` job) shapes the generated
  workspace like the first adopter's (a second generated app, an adapter, a sibling package, a seamless negative
  fixture) and runs the script's own checks; `generated` (CI's `adoption-probe` job) changes not one file and runs
  the workspace's own gates (`pnpm verify`, the unit and contract runs held to the conformance suite,
  `sssb ci lint-typecheck-unit`, `sssb ci synth`, `pnpm knip`, `pnpm jscpd`), then proves its workflow pin, its plugin
  marketplace pin and the packed kit's stamp are one commit, which holds the plugin: **commit the plugin before a local
  run**, as the starter. No flag runs both. A change to what a
  package ships, its manifest, the generator or the starter shows there first. Its gaps are named workarounds in
  `scripts/pack-and-consume/workarounds.mjs` (none today), each removed by a later ADR-0014 step: never patch the
  consumer silently. Both shapes install from one committed lockfile seed, with tokens for the tarball directory and
  the group's version; when its notice says the resolution moved, refresh it with
  `pnpm pack-and-consume --update-lockfile` and commit `scripts/pack-and-consume/consumer-lock.yaml`.
  **Any migration/db change: `pnpm test:contract` here runs the same RLS proofs** for EVERY app AND SSSB's fixture
  seam, each in its own database, each twice: once through the `pg` driver and once through the RDS Data API driver
  and its emulator, each also as a non-superuser owner, `packages/kit/src/db/owner-pass.ts`, which grants a later owner
  ADMIN on `app_user` and on the roles the seam names in `appRoles` (the fixture's
  `packages/kit/test-fixture/app-config/db/migrations/1004_fixture_docket_clerk.ts` is the case). An app's are the contract
  runner's, `contractSuite` from `@sssb/kit/testing/contract`, called from `apps/<app>/tests/contract/`, with the
  conformance suite's opt-outs and skip guard; SSSB's fixture keeps its own in `packages/kit/src/adapters/real`.
  **Also wipe `apps/*/.data` after changing `packages/seed`** — the app seeder is guarded by "does this
  world have any rows yet", so new seed rows are invisible on an existing world and only CI sees them.
- **Keyset paging, worked example**: `apps/showcase/src/domain/db/tickets.ts` + `apps/showcase/src/app/api/tickets/route.ts`,
  with the index in `apps/showcase/src/app-config/db/migrations/1004_tickets_keyset_index.ts` and proofs in both
  RLS suites. The primitive opens `withTenant` itself and re-runs the whole scoped query on every page.
- **`sssb/no-raw-db-handle`** is deny-by-default: it covers every module under `apps/*/src`, SSSB's screens and SSSB's
  fixture, so a new directory is covered before anyone names it (tests outside routes, screens and the fixture are the
  one exception); nobody edits `eslint.config.mjs` for an exception. The showcase's tenant tables copy
  `apps/showcase/src/app-config/db/migrations/1001_tickets.ts`; framework migrations (0001–0999) live in
  `packages/kit/src/db/migrations` (ADR-0012).
- **The authorization scan, maintainer side**: the framework's own reference tree, `packages/kit/test-fixture/api`,
  is scanned by `packages/kit/src/authz/authorized-mutations.test.ts`, reading each handler with the TypeScript
  parser (`packages/kit/src/authz/route-scan.ts`); each app's scan, the conformance suite's `authz-mutations` check,
  is `packages/kit/src/authz/app-exemptions.ts`, which applies the app's own exemptions. The FRAMEWORK's exemption map is
  `packages/kit/src/authz/route-policy.ts`, and its staleness is measured against the FIXTURE tree, so a new framework
  exemption needs a file there to demonstrate it; the fixture's routes are scanned, never served. An app's entry that
  overlaps a framework one, or a prefix nested in another of the app's, fails. **Every exemption's `mustMatch`** is
  checked on each verb (the handler IS the guard's call, reaches a port call, or opens with the simulated-mode 404),
  every name in it a value import kept under its exported name, so a local look-alike or an alias is not the gate —
  entries are matched by relative path in every root, so a gateless one would exempt an adopter's same-named route from
  authorization entirely. It proves the route is the KIND the reason describes, never the reason's whole claim;
  ADR-0012 states the limit.
- A `knip.json` entry is justified in `docs/build-notes.md`. CI additionally runs coverage reporting, jscpd
  duplication, gitleaks secret scanning and the licence scan (`scripts/licence-scan.mjs` against
  `.github/licence-policy.json`: a new copyleft, source-available or unknown licence in the installed closure fails
  it unless the policy names it with a reason; `pnpm install` first, then `node scripts/licence-scan.mjs`) — see
  `.github/workflows/checks.yml` and `.github/workflows/app-checks.yml`.
- Unit tests are colocated (`*.test.ts(x)`), run by Vitest — `vitest.config.ts` has ONE PROJECT PER APP
  because `@sssb/app-config/*` is a bare specifier and a single alias can only name one app, PLUS a `kit`
  project that runs the packages' suites against the framework's own seam (`packages/kit/test-fixture`). SSSB's
  conformance suite (`@sssb/kit/testing`; its checks and fixed test names are `packages/kit/src/testing/checks.json`)
  runs in every app (`tests/tooling/app-scaffold.test.ts` fails an app without its suite file), and in the `kit`
  project against the fixture; that is what proves the seam against real apps rather than only against the fixture.
  E2E: showcase on :3000, starter on :3100; in a linked worktree both are derived per checkout by `@sssb/tools/ports`,
  and `SHOWCASE_PORT`/`STARTER_PORT`/`LADLE_PORT`/`CONTRACT_PG_PORT` override it (the last also isolates
  `pnpm test:contract` between worktrees). Each app declares its slot in its package.json
  (`"sssb": { "port": "starter" }`); the slot is a port band, not the app's name, so the app `@sssb/create` writes
  keeps `starter` too.
- **Scratch directories in this repo's tests**: `tests/support/tmp-dir.ts` re-exports `@sssb/tools/testing/tmp-dir`,
  and the framework's own tests use its copy, `packages/kit/src/testing/tmp-dir.ts`; `sssb/no-direct-mkdtemp` bans the
  raw calls in test files, and `test:unit`, `test:coverage` and `test:contract` run through `sssb check-tmpdir-leak`.
- **E2E `workers` stays 1** (the old "10GB VM / OOM" reason was wrong; measured). Parallelism belongs where the worlds
  are separate: across apps locally, across CI shards. Read
  `.claude/future-tasks/e2e-shared-world-blocks-parallelism.md` before raising it.
- Component workshop: `pnpm ladle` (screens AND react-email templates).
- **The dev ticker** (the guide's dev loop) is `@sssb/tools/ticker` (start, stop, status), policy-free; all of it
  lives in `packages/tools/src/tick`. Here `pnpm tick` ticks the showcase and `pnpm tick:starter` the starter, and
  the showcase's Simulator (Jobs tab) starts and stops it inside the dev server
  (`apps/showcase/src/app/api/simulator/ticker`, 404 outside a simulated `next dev`: kit's `isSimulatedDevServer`).
  The playwright configs blank the variable and refuse to load while a ticking dev server's marker is live.
- **A PR that changes what ships to adopters adds a changeset** (`.changeset/README.md` has the template and what
  counts): every `@sssb/*` package's shipped files and `apps/starter`, the generator's template. It is the release-note entry, with a "Now deletable" part,
  and `changeset-required` in CI fails the PR without one. Adopters would see no difference: an empty changeset. A
  change to a release snapshot (`packages/cdk/release-snapshots/`, the stateful logical ids;
  `packages/kit/release-snapshots/`, the required environment) needs one that files `minor`.
- Conventional commits: lowercase subject, ≤100 chars (commitlint hook enforces).
- Before opening a PR, run `/sssb:pre-pr` (verify + subagent branch review).
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
- **Commands.** The app-author ones are SSSB's Claude Code plugin (`plugins/sssb/`, served by this repository's
  marketplace, `.claude-plugin/marketplace.json`), which this repository's `.claude/settings.json` enables as
  `sssb@sssb` but does not declare, so without one of the two steps below nothing loads: no `/sssb:*` command and no
  `sssb:doc-steward` agent. **Installed**, once per checkout (each worktree too):
  `claude plugin marketplace add ./ --scope local`, then `claude plugin install sssb@sssb --scope local`. That is a
  copy at the commit then checked out (Claude Code 2.1.280 copies it into its plugin cache under that SHA); after
  committing a change to it, `claude plugin update sssb@sssb --scope local` and a restart load it, and an uncommitted
  edit never does. (Claude Code's plugin docs, "In-place and copied plugins", describe a later release that loads a
  local marketplace's relative-path plugin in place, uninstalled; check `installPath` in your config's
  `plugins/installed_plugins.json` before trusting either.) **The working tree's**, uncommitted edits included: start the session with
  `claude --plugin-dir plugins/sssb`, which loads `plugins/sssb` as it is for that session and replaces an installed
  plugin of the same name (Claude Code's plugin docs, "Name conflicts"; `claude plugin list` still shows both). Adopters enable it at a pinned commit: `/sssb:verify`, `/sssb:pre-pr`, `/sssb:new-slice`, `/sssb:new-port` (a port
  the APP owns), `/sssb:a11y-review`, `/sssb:design-review`, and the capability scaffolds `/sssb:new-entity`,
  `/sssb:new-job`, `/sssb:new-actor`, `/sssb:new-notification-kind`, `/sssb:new-webhook-event`, `/sssb:new-tour`,
  `/sssb:new-preset`, `/sssb:new-preset-operation`; and the `sssb:doc-steward` agent. They address the app through the
  root `package.json`'s `sssb.apps`, and must work in a generated workspace: `tests/tooling/plugin.test.ts` fails a
  path, script, `sssb` command, `@sssb/kit` subpath or rule id one names that a generated workspace lacks. Maintainer-only, in `.claude/commands/`:
  `/new-kit-port` (a framework port in `packages/kit`), `/record-fixtures`, `/branch-review`, `/sub-review`,
  `/repo-health`.
- Record important lessons in `docs/build-notes.md`; unplanned decisions in `docs/decision-log.md`;
  designed-but-unbuilt work in `.claude/future-tasks/` (one file per item, listed in its `index.md`).
  Amend an ADR by appending a dated addendum — never by editing what its body said.
- **Doctrine docs are gated**: `tests/docs/doc-paths.test.ts` fails if a doctrine doc cites a repo path
  that doesn't exist. The doc set and its exemptions are `sssb.docPaths` in the root `package.json`, read by
  `@sssb/tools/doc-paths` (`sssb check-doc-paths` runs the same engine) through `tests/docs/doc-set.ts`; the app guide
  is read against `apps/starter` (`sssb.docPaths.relativeTo`). The dated
  records (`build-notes.md`, `decision-log.md`, ADR bodies and anything appended to them) are exempt — see
  `docs/README.md` for the split. If you move a directory, the gate is what tells you which docs you
  just falsified. A citation of `apps/showcase` or `apps/starter` is checked strictly while that app
  exists and passes where it does not (it then names SSSB's reference app, and a doc merged in from
  upstream must not turn an adopter's gate red); write `apps/<app>/…` when you mean the reader's own app.
- **An adopter's workspace is generated, not forked**: `pnpm create @sssb <dir>` (`@sssb/create`, ADR-0014 P12)
  writes it from `apps/starter` plus generated root config, renaming the app on the way. The generator renames
  only the app's identity, each in one place that `packages/create/src/generate.js` names: `APP_SLUG` and the
  `<slug>_session` cookie in `apps/<app>/config/app.ts`, `welcome.appName` and `welcome.title` in
  `apps/<app>/messages/{en,es}.json`, the title in `apps/<app>/src/app/[locale]/layout.tsx` and in
  `apps/<app>/src/demo-static/index.html`, and the app's and its infra's package names. Anything new in the starter that names the app's directory or the product's display name must go through
  one of those (or become a new rename there, which must find its text exactly once), and **never hard-code the
  product name in a test**; specs read the app's own catalog via `apps/*/tests/catalog.ts`. Everything else is
  copied as written, so **starter prose must read true in an adopter's tree**: a comment that names the showcase,
  "the starter", the framework's source tree (say `@sssb/kit/…`), a relative path out of the app, or SSSB's spikes,
  build notes or decision log fails `tests/tooling/create-generate.test.ts`. Any other path into this repository (a
  doc's, say) passes it, so say it is SSSB's. The app guide is held to the same test: the workspace carries a copy.
  See `docs/adopting.md`.
- At the end of a slice or before a PR, run the `sssb:doc-steward` agent on the branch diff — it
  proposes updates to development-approach, an ADR addendum, decision-log, build-notes, and the
  cutover checklist so the docs keep telling the truth. It also reports the net line delta of each doctrine doc
  the diff touches, and proposes deleting superseded text in the same pass (records excepted).
