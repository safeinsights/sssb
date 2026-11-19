# Adopting SSSB: the reference

The detail behind [the adoption guide](adopting.md), which walks a new app from `pnpm create @sssb` to its first
release upgrade in order and links here for everything it leaves out. Read a section when you need it.

## What is yours, and what is SSSB's

Three kinds of thing are involved (see [ADR-0012](adr/0012-framework-app-line-and-registration.md) for the line
between framework and app):

- **Your workspace**, every file `@sssb/create` wrote: the app under `apps/<app>/` (its routes, its seam in
  `apps/<app>/src/app-config/`, its screens, domain, seed, catalogs and tests), its deployment in
  `apps/<app>/infra/`, the root config on SSSB's presets, the CI workflow, the owner files, the cutover checklist,
  `README.md` and `CLAUDE.md`. All of it is yours to edit. A release never changes it: where a release changes what the
  generator would write, its notes say what to change by hand ("Upgrading, step by step" below).
- **SSSB's packages**, installed as dependencies at one version, which you never edit:
    - **`@sssb/kit`**, the framework: ports and adapters, RLS tenancy, authz, jobs and schedules, webhooks in and out,
      notifications, agreements and gates, the Simulator dev and demo harness, its screens and its half of the i18n
      catalog, the conformance suite (`@sssb/kit/testing`) and the app guide. You extend it through the seam. (Its route
      wrappers necessarily stay in your `apps/<app>/src/app`: Next.js requires it.)
    - **`@sssb/tools`**, the `sssb` CLI (`sssb doctor`, `sssb guide`, `sssb check-fences` and the rest), the Next,
      Vite and Vitest presets and the tsconfig base your configs extend, and helpers for your tests: a test that needs a
      scratch directory calls `makeTestTmpDir()` / `makeTestTmpDirAsync()` from `@sssb/tools/testing/tmp-dir`, never
      `mkdtemp` (lint bans it), and `test:unit`, `test:coverage` and `test:contract` run through
      `sssb check-tmpdir-leak`, which fails the run if a directory made that way survives it.
    - **`@sssb/eslint-plugin`**, the lint fences, applied by your app's `eslint.config.mjs`.
    - **`@sssb/cdk`**, the `SssbApp` construct your `apps/<app>/infra/` stack holds.

    Beside them, pinned to the release's commit of SSSB's repository: the **reusable CI workflow** your
    `.github/workflows/checks.yml` calls, and the **Claude Code plugin** your `.claude/settings.json` enables.

- **SSSB's repository**, which you read and never copy. `apps/showcase`, a support desk (tickets, escalations,
  attachments, two job kinds, two actors, six people), exists so every framework capability has a living worked
  example; the generator never copies it. `apps/starter` (one entity, one card, two tenants, and a seam whose other
  eleven modules register nothing) is the generator's template, the app you started from. It is also the framework's
  second consumer, which is what makes the framework/app line falsifiable rather than merely asserted: anything SSSB
  reaches for that only exists because the showcase supplies it fails to compile there. SSSB's docs (this one, the
  ADRs, the recipes, the runbooks) live there too.

Apps live under `apps/`, one per product, each with its own `package.json`, configs and tests (ADR-0007). One app is
the usual shape: it sits under `apps/` so that a second app, or a package of your own under `packages/` (a CLI, an edge
function), is a sibling rather than a special case, and so that the root's commands mean the same with one app or
several. The root
commands that act on every app (`pnpm build`, `pnpm typecheck`, `pnpm test:e2e`, the fences, the demo-static trio)
fan out over `apps/*`, so they pick up a second app with no edit; the root's `sssb.apps` names the apps one by one, and
the root's Vitest configs read it, so a second app is one entry there, which `pnpm exec sssb add-app <slug>` writes with
the app ("A second app: `sssb add-app`" below). The commands that must pick ONE app
(`pnpm dev`, `pnpm tick`, `pnpm start`) name the generated app; "The workspace's scripts and gates" below lists every
root script.

## `pnpm create @sssb`

`--help` prints the usage (`packages/create/src/args.js` holds it):

```
usage: pnpm create @sssb <dir> [options]      (npm create @sssb <dir> -- [options])

Creates a new SSSB app workspace in <dir>, which must not exist or be empty: the app under apps/<slug>/ (with its
own infra/), the workspace's config on SSSB's presets, the owner files and a CI workflow calling SSSB's checks.

  --slug <slug>          the app's slug: lowercase letters, digits and dashes, from a letter. It names the app's
                         directory (apps/<slug>), its package, its cookies and its database (default: <dir>'s
                         name, lowercased)
  --name "<Name>"        the app's display name, in its copy and titles (default: the slug, title-cased)
  --repo <owner/name>    the GitHub repository the workspace will live in, for the security, conduct and issue
                         links (default: PLACEHOLDER_GITHUB_OWNER/PLACEHOLDER_GITHUB_REPO, for you to replace)
  --owner <@handle>      a code owner for CODEOWNERS, a user or an @org/team; repeat for several (default: a
                         placeholder, for you to replace)
  --sssb <version|dir>   the @sssb/* packages to depend on, at this generator's version: that version, exact or
                         with ^ or ~ (default: ^<this generator's version>), or a directory of their packed tarballs
                         (sssb-kit-*.tgz and the rest), which are then depended on by file: path
  --workflow-ref <sha>   the commit of SSSB's reusable workflow to pin (default: the commit this generator was
                         packed from)
  --yes                  do not ask before writing
  --help                 print this
```

What it refuses, before it writes anything:

- **A slug** that is not lowercase letters, digits and dashes starting with a letter, whose database name (each dash
  an underscore) is longer than 63 characters, or whose database name is a word Aurora PostgreSQL reserves (`user`,
  `select`, `postgres` and the rest). The list is a copy of `@sssb/cdk`'s (`packages/cdk/src/database-name.js`), so
  a slug the construct would refuse at synth is refused where it is chosen; `tests/tooling/create-args.test.ts`
  holds the two lists equal. When `<dir>`'s name is not a valid slug, pass `--slug`. Also refused: a slug that would
  give the app (`<slug>`), its infra (`<slug>-infra`) or the root (`<slug>-workspace`) the name of a package the
  workspace installs (`ws`, `react`, `next`, `kysely` among them), which pnpm would mistake for that package.
- **A second positional argument** (the display name is `--name`), an unknown option, and any option but
  `--owner` given twice. `--flag=value` works as well as `--flag value`.
- **A `--repo`** that is not `owner/name` in the characters GitHub allows, **an `--owner`** that is not a GitHub
  user or team (the `@` may be left off; a repeated owner is written once), **a `--sssb`** that is neither a
  directory of tarballs nor a version (`0.2.0`, `^0.2.0`, `~0.2.0`, a prerelease suffix allowed: `latest` and `>=`
  ranges are refused), or that names a version other than the generator's own (the workspace's copy of the app guide
  is the generator's version's, and `sssb doctor` fails one that differs from the installed kit's: run that version's
  `@sssb/create` instead), and **a `--workflow-ref`** that is not a full 40-character commit SHA.
- **A display name** (`--name`, or the slug title-cased) that is not one line of at most 60 columns (a wide character
  counts two) in letters, marks, digits, emoji, spaces and `. , ' ’ " & ( ) ! ? : / + % ; = ~ _ # -`, starting with a
  letter or a digit. Whitespace is trimmed and each run of it made one space. The rest are refused rather than escaped,
  because the name lands in markdown, HTML, the app's message catalogs (ICU: `{ }`, `<tag>`, `''`) and TypeScript and
  JSON strings, and must read as itself, Prettier-clean, in all of them; for the same reason `_` only inside a word, at
  most one `~`, no `#` as a word of its own at the end, no `''`, and no `&` that markdown reads as a character
  reference (`&#…`, or `&` then letters or digits then `;`: `R&D` and `Q & A` are fine, `&amp;` is not).
- **A `<dir>`** that exists and is not an empty directory, or is a symbolic link. A directory holding only `.git`,
  `.DS_Store` or `lost+found` counts as empty, so `gh repo clone` of a new repository, then
  `pnpm create @sssb .` inside it, works; those entries are left as they are.

`--yes` skips the one question it asks, "Create the <Name> workspace in <path>? [Y/n]". It asks only when standard
input is a terminal, so a script or CI never waits on it; answering `n` writes nothing.

**It writes everything or nothing.** The workspace is written into a hidden directory inside `<dir>` and moved up
into it at the end; `<dir>` itself is created if it is missing and never removed or replaced if it was there. A
failure part-way, a Ctrl-C, a `kill` or the terminal closing (SIGINT, SIGTERM, SIGHUP), also while a generator run
from a checkout builds its template, removes what that run wrote and the directories it created, and the process
ends as the signal asked.

### What it writes

- **Your app**, `apps/<slug>/`: the starter, renamed, and nothing else changed in its source. The renames are
  `APP_SLUG` and the session cookie (`<slug>_session`) in `apps/<app>/config/app.ts`, the package names (`<slug>`,
  and `<slug>-infra` for `apps/<app>/infra/`), and the display name in both catalogs (`welcome.appName`,
  `welcome.title`), the root layout's title and the static demo's `<title>`. Around it: `@sssb/*` dependencies at
  the `--sssb` you chose, `@sssb/eslint-plugin` and `eslint` added, a `tsconfig.json` on `@sssb/tools`' base that
  keeps only the app's own `@/*` alias, an `eslint.config.mjs` applying the preset, and the seam package
  (`apps/<app>/src/app-config/package.json`, a workspace package named `<slug>-app-config`, which the app declares
  under the name the framework imports, `"@sssb/app-config": "workspace:<slug>-app-config@*"`: a `link:` would be
  unlinked from the app's `@sssb/kit` by the next `pnpm add <pkg>`, `remove` or `update <pkg>` for the app). Its
  `exports` map is one pattern for the flat seam modules (`./*` to `./*.ts`) plus each directory module by name
  (`./db/migrations`), so every specifier the framework imports resolves, and a seam module a later release adds is
  exported once you write it. It declares the app's own module `type`, which for the starter is none. The app's and
  its infra's `package.json` carry no `license` (both are private; the licence is yours to choose). The app keeps
  its conformance test (`apps/<app>/src/sssb.conformance.test.ts`) and its deployment, `apps/<app>/infra/`, which
  the app's `typecheck` covers with `apps/<app>/infra/tsconfig.json`.
- **The root**: `package.json` (named `<slug>-workspace`; its scripts, `verify` included, and `sssb.apps`),
  `pnpm-workspace.yaml` (each app's seam, `apps/*/src/app-config`, among its packages; SSSB's `allowBuilds`
  approvals, `dedupePeerDependents: false`, a `peerDependencyRules` entry that silences the eslint 10 warning
  from `eslint-plugin-react` and `eslint-plugin-jsx-a11y` (delete it when both declare eslint 10), and SSSB's
  `minimumReleaseAge` with `@sssb/*` exempt), the Vitest configs on `@sssb/tools/vitest` (`vitest.config.ts` and
  `vitest.contract.config.ts`, a project for each app `sssb.apps` names), `tsconfig.json`, `eslint.config.mjs` (for the root's own files), knip, jscpd,
  gitleaks, git-ignore and Prettier-ignore configs, and lint-staged's. `.editorconfig`, `.nvmrc`,
  `.prettierrc.json`, the two husky hooks and `commitlint.config.mjs` are copied from SSSB's root as they are.
- **CI**: `.github/workflows/checks.yml`, on pushes to `main` and on pull requests, with three jobs. `sssb` calls
  SSSB's reusable workflow (`.github/workflows/app-checks.yml` in SSSB's repository) pinned to a commit, with
  `contents: read`, no secrets and `synth: ./apps/<slug>/infra`, so its checks are named `sssb / <job>` and
  `sssb / all-checks` is the one to require. `workspace-checks` runs knip and jscpd, which SSSB's workflow does not;
  `secret-scan` runs gitleaks over the whole history with your `.gitleaks.toml`.
- **The owner files**, from `--repo` and `--owner`: `CODEOWNERS`, `SECURITY.md` (your own short policy, which
  points at SSSB only for a root cause in a shape SSSB gave the app), `CODE_OF_CONDUCT.md`, and under
  `.github/ISSUE_TEMPLATE/` a two-field bug form and a `config.yml` linking the security advisory form.
- **A `README.md`** of your own, **`docs/cutover-checklist.md`** and **`apps/<app>/DEMO-SIZE.md`** (both under
  "What the generator leaves for you" below).
- **`.claude/sssb-guide.md`**, SSSB's app guide as `pnpm exec sssb guide` writes it: a stamped copy of the one
  `@sssb/kit` ships, which `sssb doctor` requires, and a short **`CLAUDE.md`** that imports it (below, "Your README
  and agent guide").
- **`.claude/settings.json`**: SSSB's Claude Code plugin marketplace (`sssb`), pinned to the same commit as the
  workflow, and its plugin enabled (`sssb@sssb`; below, "Your README and agent guide").

It writes no `LICENSE`, no `.github/dependabot.yml` and no `.changeset/`: a
workspace that publishes no package has no use for SSSB's release-note machinery, and an adopter who wants a
changelog adds Changesets themselves. The workspace's `packages/*` glob is there for packages of your own; none
is written.

### Identity and the owner files

`APP_SLUG` (in the app's `apps/<app>/config/app.ts`) is the single source of MECHANICAL identity — session and
viewpoint cookies, the fake-auth JWT issuer, the service-token audience, webhook header names, CDK
stack/DB/budget/tags all derive from it. Other identifiers are deliberately NEUTRAL and never need
renaming (`APP_DATA_DIR` and the `app-simulator-*` browser keys). The dev-server port slot is named for the slug by the generator ("Port slots" below). What is left is display copy, package naming, and the owner files.

The owner files route YOUR users — a security report, a code-owner review, a conduct complaint — so they must
name you, never SSSB's maintainer. The generator writes them from its flags: `--repo` fills the advisory links in
`SECURITY.md`, `CODE_OF_CONDUCT.md` and `.github/ISSUE_TEMPLATE/config.yml`, and `--owner` fills `CODEOWNERS` as
`*   <owners>`. Without `--repo` those links name `PLACEHOLDER_GITHUB_OWNER/PLACEHOLDER_GITHUB_REPO`; without
`--owner`, `CODEOWNERS` names `@PLACEHOLDER_GITHUB_OWNER` under a comment saying to replace it. Either way the
generator's closing output ends "Still to fill in: …" naming them, and the generated `README.md` lists the files to
edit. A `CODEOWNERS` naming an account GitHub cannot resolve makes every PR unmergeable once "require review from
Code Owners" is on.

**`--repo` names the repository, which is not the app's slug.** An app called `console` can live in a repo called
`pages`, and a link that says `…/console/security/advisories/new` 404s while looking right.

Filling in the owner and repository is necessary and not sufficient: **every one of those links depends on a
repository setting that is off by default.** `/security/advisories/new` resolves for a non-maintainer only once
**private vulnerability reporting** is on (Settings → Code security). Leave it off and your security policy and
your conduct policy name a private channel that does not exist, so the only route left is the public issue you
just told people not to open. Turn it on when you push.

The framework's catalog holds no product name: `AppHeader` and `DemoShell` take a **required** `appName` prop, and each
app passes its own from its `welcome.appName` key, the one the generator writes. A default would resolve, and look
right, while showing another product's name.

### Port slots

**Your app's port slot is its own.** The keys in `@sssb/tools/ports` name a dev-server SLOT (a port in a main
checkout, a band a linked worktree derives from), and the app declares its slot in its own `package.json`. The
generator gives the app a slot named for its slug, at port 3700:

```json
"sssb": { "port": { "name": "acme", "default": 3700 } }
```

Its override is `ACME_PORT` (`<NAME>_PORT`, with `-` as `_`), and a linked worktree derives its port from 20000-29999,
keyed on the name as well as the checkout. A slug a slot cannot be named for (longer than 32 characters, with a doubled
or trailing `-`, or reading a variable of SSSB's own, as `showcase` would) gives the slot `sssb-app` (`SSSB_APP_PORT`). Nothing
else in the app names the slot: its scripts call `sssb dev-tick` and `sssb tick` with no slot, its `playwright.config.ts`
calls `originForApp(__dirname)` (from `@sssb/tools/ports`; Playwright compiles the config to CommonJS, and the
directory finds the app wherever the config is loaded from, the workspace root included when `pnpm knip` loads it),
and each reads the declaration, as `sssb port` does. So renaming the slot is one edit, in `package.json`. The name is
lowercase words joined by `-`; the default is an integer from 1024 to 49151 outside the ports SSSB's own services use
(3000, 3100, 3200-3599, 5439-5639, 20000-29999, 61000-61199).

A workspace generated before this declares SSSB's built-in slot instead, `"sssb": { "port": "starter" }` (port 3100,
`STARTER_PORT`), and its scripts and Playwright config may still name it (`sssb tick starter`, `sssb dev-tick starter
--`, `originFor('starter')`). That keeps working. To give the app a slot of its own, change the declaration, drop
`starter` from those scripts, and call `originForApp(__dirname)` in place of `originFor('starter')`: an app on a slot of
its own that still names `starter` is refused by `sssb tick`, `sssb port` and `portFor`, since it would tick and test
another app's port.

**A workspace with two apps gives each its own slot.** Two apps on one slot would bind one port: the second dev server
fails to start, or, worse, the second app's e2e run adopts the first app's server. `sssb doctor` fails two apps that
declare one slot, or two slots with one default, and a declaration that is not valid.

### A second app: `sssb add-app`

**`pnpm exec sssb add-app <slug>` writes the second app** (`--name "<Name>"`, `--slot <name>` and `--port <port>` are
optional). It takes the starter from the `@sssb/create` installed at the workspace root, at your SSSB version
(`pnpm add -D -w @sssb/create@<version>`; the command prints the line when it is missing), renames it as the generator
renamed your first app, and writes it under `apps/<slug>/`, taking each `@sssb` package as your first app takes it, on
a slot of its own (named for the slug, its default the first free one from 3700 up: 3800 beside a generated app), and
names it in the root's `sssb.apps`. Then `pnpm install` and `pnpm exec sssb doctor`, which names what the workspace
still needs: a root Vitest config that keeps a list of apps of its own (one written before `@sssb/tools/vitest`'s
`workspaceAppProjects`), and, as a report, a `knip.json` with no workspace for the new app and its seam (copy the first
app's two entries), and a root `@sssb/create` that knip would call unused (remove it once your apps are written, or
ignore it in `knip.json`). The root's `dev`, `tick` and `start` scripts and the CI workflow's `synth` name one app on
purpose; the command says what to add for the second. **`pnpm jscpd` fails while the new app is still the starter**:
`.jscpd.json` measures duplication across every app's source, and two copies of the starter are one; make the apps your
own, or, while you do, add `"apps/<slug>/src/**"` to its `ignore` and take it out again once the app is its own.

Nothing the generator renames is a literal an adopter has to hunt for, and no test hard-codes the product's
name: `apps/*/tests/catalog.ts` reads the app's own catalog and the specs assert against that. A rename
cannot break the gate.

### What the generator leaves for you

These are the parts that take judgement:

- **Deployment parameters** — `apps/<app>/config/params.ts`, which every app carries (the starter's is yours from the start).
  Every `PLACEHOLDER_` value, and `sentry.org`. Each maps to a cutover row.
- **The starter's content** — its seed world, its welcome copy, its one entity and its static-demo
  wiring are all still there and all still on screen. The generator renamed the app around them. The next
  section lists each one and what to do about it.
- **The cutover checklist** — the generator writes `docs/cutover-checklist.md` into your workspace: a task list
  with one `- [ ]` line per framework cutover row (`packages/kit/src/cutover/rows.json`, less the rows scoped to
  SSSB's own repository), each its id and what it is. It is yours: add owners, dates, the proof each row owes, and
  rows of your own. Keep every id in it: `sssb doctor` reports a framework row the file stops mentioning, and the
  app's `apps/<app>/config/params.ts` names the row behind each placeholder. SSSB's own [cutover-checklist.md](cutover-checklist.md)
  shows the level of detail a row deserves.
- **The demo size budget** — `apps/<app>/package.json`'s `check:demo-size` passes the static demo's byte
  budget. It is yours now. The starter ships it roomy on purpose, sized for an app's own screens and not as
  a pacing gate (it still fails on gross bloat); re-set it when you want a tighter gate, to what your app
  measures plus the headroom you want, in its own commit. The generator writes `apps/<app>/DEMO-SIZE.md` beside
  it, fresh rather than copied: it says what the number is for, the budget at generation, and how to change it,
  and its "Changes" list, empty, is where you record each change and why (SSSB's history of the starter's budget
  stays in SSSB's repository).
  `sssb check-demo-size` is SSSB's (`@sssb/tools`) and holds no number: the number lives in the app's
  `package.json`, so re-set it there. When it goes red,
  the command's source (`packages/tools/src/commands/check-demo-size.js`, "WHEN IT GOES RED") says what to look at first.
- **The licence** — SSSB is MIT, which means the product you build on it is yours with no copyleft obligation. The
  generator writes no `LICENSE`, and the `README.md` it writes says to add one: your product's licence is a
  decision you make.
- **Your README and agent guide.** The `README.md` the generator writes is yours to fill in. It starts with the
  first commands, the layout, the repository settings only you can make (the ones above, plus replacing any
  placeholder the generator left and adding a `LICENSE`) and how to upgrade SSSB. The workspace gets
  `.claude/sssb-guide.md`, the app guide (the app-facing half of SSSB's `CLAUDE.md`) that `@sssb/kit` ships, and a
  `CLAUDE.md` that imports it (`@.claude/sssb-guide.md`) above a heading for your own rules: the file is yours from
  then on, so keep the import line. Edit nothing in the guide's
  copy (a rerun overwrites it). Its header stamps the hash of the guide it was copied from, and `sssb doctor` fails
  when that is not the installed kit's guide, so after an upgrade `pnpm exec sssb guide` refreshes it and the change
  reaches your diff. The app-author commands arrive as SSSB's Claude Code plugin, which `.claude/settings.json`
  enables from SSSB's marketplace pinned to the workflow's commit: `/sssb:new-slice`, `/sssb:new-entity` and the
  rest. A commit `ref` needs Claude Code 2.1.324 or later, and enabling it does not install it: each person runs
  `claude plugin install sssb@sssb --scope project` once per clone, after trusting the folder.

### The starter's content is still wired into your UI

A rename changes what the app is called, not what it shows. In the app the generator writes, four pieces
of the starter are still reachable by anyone who opens your app or your static demo:

| What survives                                                | Where it lives                                                                                                                                                                                                                                                                                                                                                                                   | Where it shows                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| The seed world: two tenants, two teams, 3 people             | `apps/<app>/src/seed/index.ts`                                                                                                                                                                                                                                                                                                                                                                   | every sign-in picker (the app's, the static demo's, the Simulator's People tab); tenant themes |
| The welcome subtitle                                         | `welcome.subtitle` in `apps/<app>/messages/en.json` + `es.json`                                                                                                                                                                                                                                                                                                                                  | the app's root page AND the static demo's first screen — they share one component              |
| The Items slice (`pnpm exec sssb remove-items` takes it out) | `apps/<app>/src/components/items-card.tsx`, `apps/<app>/src/app/api/items/route.ts`, `apps/<app>/src/domain/db/items.ts`, the dashboard route's `page.tsx` and `dashboard-glue.tsx` under `apps/<app>/src/app/`, the `Item` case in `apps/<app>/src/app-config/abilities.ts`, the table, migrations and RLS proofs under `apps/<app>/src/app-config/db/`, the `items` namespace in both catalogs | every signed-in person's dashboard                                                             |
| The static demo's composition root                           | `apps/<app>/src/demo-static/app.tsx`                                                                                                                                                                                                                                                                                                                                                             | the whole `file://` demo: it passes `nav={null}`, the starter's welcome screen and Items card  |

None of it fails a gate, which is why it is listed here: a real adopter shipped a product demo that
opened on the starter's tenants and its Items card, four days after adopting. The team had been
looking at the product signed in as its own people, and nothing they used showed them the rest.

**Replace it; do not build beside it.** The seed world is one world, and the framework's pickers list
all of it — `@sssb/kit/seed/contracts` has no notion of a person who exists but is not offered. A product
world added NEXT TO `northwind` and `westgate` therefore puts both on every sign-in screen. Nothing in
`@sssb/kit` needs the starter's names: SSSB's own tests run against `packages/kit/test-fixture` in SSSB's repository.
What does read them by literal id is yours to change in the same commit:

- `apps/<app>/tests/e2e/items.spec.ts` and `simulator.spec.ts` sign in as `person-owner` and `person-other-tenant`
  and assert the tenant names (`sssb remove-items` deletes the first); `apps/<app>/tests/demo-static/static-shell.spec.ts` signs in as `person-owner` and
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

**The Items slice is a worked example, so read what it teaches before you delete it, and delete it before you register your own.**
`apps/<app>/src/app-config/db/migrations/1001_items.ts` is a worked RLS migration — in a generated workspace, the only one there — and its
section of `apps/<app>/src/app-config/db/rls-proofs.ts` is the proof that goes with it; `1002_items_keyset_index.ts`, `apps/<app>/src/domain/db/items.ts` and the route show how a list pages. Read them,
then take Items out in one step: `pnpm exec sssb remove-items --app apps/<app> --drop-migrations` ("To remove the Items slice" below), and build
your first real slice (`/sssb:new-slice`, which cites the removed files at the pinned commit). Run it first: it refuses, naming each file, once your registrations sit
beside Items' in `abilities.ts`, `messages.ts`, the migration list, the catalogs or the dashboard's glue, and then the sweep is by hand. A database that never ran
`1001_items` (a workspace you just generated) takes that flag, and your first table is then `1001_<name>`, after you delete
`apps/<app>/.data`. Once a database has run the migrations, run it without the flag, which leaves them in place, and give your first
table the next number, `1003_<name>`: the migrator refuses a migration it recorded that is gone from the code.

**Wire the static demo last, and look at it.** A shell or a home screen you build in
`apps/<app>/src/components` reaches the real app through its route files and reaches the static demo
ONLY through `apps/<app>/src/demo-static/app.tsx` — the `nav`, `welcome` and `dashboard` props it hands
`DemoShell`. Being router-agnostic makes a component ABLE to run in the twin; it does not put it there.
When the sweep is done, run `pnpm build:demo-static`, open `apps/<app>/dist-demo/index.html`, and sign in as each seeded person.
That one look is the check: the picker, the first screen and the dashboard are exactly the three places
the starter survives.

### The workspace's scripts and gates

Your app carries the two things a workspace without SSSB's showcase still needs: the **RLS contract suite** (`apps/<app>/tests/contract/rls-contract.test.ts`, one call of `contractSuite` from
`@sssb/kit/testing/contract`, which runs SSSB's composed proof suite on real Postgres, in a database of the app's own,
by a non-superuser owner as Aurora's master user is (twice: on a fresh server, and where `app_user` already exists),
by a superuser, and over the RDS Data API transport through its emulator: the anti-drift gate CI depends on; a check is
left out only by a named `optOut`, as in the conformance suite) and **`apps/<app>/config/params.ts`**. Run locally, the
suite starts its own Postgres with `embedded-postgres`, which the starter carries as a devDependency (an optional peer
of `@sssb/kit`); with `CONTRACT_DATABASE_URL` set it uses that server instead. So leaving the showcase behind loses no gate:
`pnpm test:contract` runs your app's suite, and `tests/tooling/app-scaffold.test.ts` fails if an app registers
migrations without one, or the apps' params carry different keys (each `apps/<app>/infra/` hands its own to the same
`SssbApp` construct, which reads the same keys from every app).

The generated root's scripts are `dev`, `tick` and `start` (your app, by `pnpm --filter <slug>`); `build`,
`typecheck`, `test:e2e`, `check:e2e`, `check:fences` (`sssb check-fences` in each app, as SSSB's reusable workflow
runs it) and the demo-static trio, fanned out over `apps/*` with `--fail-if-no-match`; `synth`, over
`apps/*/infra`; `lint`, `lint:fix`, `test:unit`, `test:coverage`, `test:contract`, `knip` and `jscpd`; `prepare`
(husky, then `sssb launch-json`); `sssb:doctor`, which is `sssb doctor`: your root does not install `@sssb/kit`, so with no `--app` doctor starts from
the workspace's first app (`sssb.apps`, else `apps/*`), and one run checks every app; and
`verify`, which runs what the workspace's CI runs but the secret scan: typecheck, lint, the unit tests with
coverage, knip, jscpd, the fences, doctor, check-e2e and synth side by side, then the contract tests on their own
(`VERIFY` in `packages/create/src/files.js` says why), the e2e suites and the static demo.
Five of this repository's root scripts are not there because the starter does not ship the capabilities behind them:
`dev:real`, `llm:record`, `ladle`, `build:demo`, `start:demo`. They come back with the thing they
drive — a Sentry/params-wired `next.config.ts` and a real-mode preflight for `dev:real`, an
`@sssb/app-config/assistant` registration for `llm:record`, `@ladle/react` plus a `.ladle/` config for the
workshop, Panda codegen for the demo build. Copy each from the showcase in SSSB's repository if you want it. The
rest of this repository's are SSSB's own: the second app's (`dev:starter`, `tick:starter`), releasing
(`changeset`, `release:check`, `release:notes`, `release-app`, `release-app:init`), `pack-and-consume` and
`pre:commit`.

One gate is relaxed in the generated workspace. SSSB's knip workspace carries `includeEntryExports: true`, which
means "every symbol SSSB PUBLISHES must have a consumer" — an invariant the showcase made true by using
nearly all of it. A one-entity app does not: `apps/starter` imports 41 of SSSB's 142 published subpaths from its source (45
counting its tests), so the same setting would start demanding you delete the other 101 — capabilities you merely have not
reached yet, not dead code. The generated `knip.json` therefore leaves it off. knip keeps reporting unused
files, and the declared `exports` surface goes back to being what it is without a rich consumer: a
declaration. The generated `knip.json` carries a few narrow entries beside the app's entry files: at the root,
`vitest.contract.config.ts` as an entry (knip's Vitest plugin reads only `vitest.config.ts`) and `esbuild` as an
ignored dependency (`@sssb/cdk` bundles the migrator with the root's esbuild at synth); in the app,
`@sssb/app-config`, `@vitejs/plugin-react` and `vite-plugin-singlefile` as ignored dependencies (the seam the
framework resolves, and two tools SSSB's presets load from the app's directory); and the seam, a workspace of its own
to knip, with every `.ts` file an entry, since what reads most of it is the framework, from `node_modules`, which knip does not follow. Their reasons are in
`packages/create/src/files.js`, since JSON holds no comments.

`pnpm verify` is green on a freshly generated workspace, end to end: on every pull request SSSB's CI generates one with
the packed `@sssb/create` from the packed packages and runs its `pnpm verify`, as the required check `adoption-probe`.
SSSB's own tests run against a seam of the framework's own in SSSB's repository (`packages/kit/test-fixture`), never
against your app's world.

What does run against your app is the conformance suite, `@sssb/kit/testing` — the authorization scan of
your route tree, the i18n partition/parity checks, the pglite RLS suite, migration order, the app's named roles, the
demo-presets check and the seam map — which your app runs from its own tree: `apps/<app>/src/sssb.conformance.test.ts` calls
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
sure CI runs the config doctor names. Before any of that it fails a workspace pnpm installed with a `nodeLinker` other
than `isolated`, pnpm's default (`pnp` or `hoisted`, from `pnpm-workspace.yaml`, a `pnpm_config_node_linker` variable
or a `--config.node-linker` flag): every app needs its own `@sssb/kit` linked to its own seam, which `hoisted` cannot
give, and under `pnp` scripts run under Plug'n'Play, where Vitest's listing never finishes; nothing else is checked
until it is. It fails the same way while `.pnp.cjs` is left at the root, since `pnpm run` keeps loading it after the
setting is gone: delete it and reinstall. Each `vitest list` doctor runs is stopped after 120 seconds, with every
process it started (on macOS and Linux; on Windows only Vitest's own process; `SSSB_DOCTOR_VITEST_TIMEOUT`, in
seconds, changes the limit), so a listing that never finishes is a problem doctor names rather than a hang; after one
listing runs out of time, doctor does not wait on the rest. It also fails a second copy of
any peer `@sssb/kit` declares (React, Next,
Kysely...), an importer of the framework anywhere in the workspace that does not run on its own seam or declares it as
a `link:` (which the next `pnpm add <pkg>` for the app unlinks) or by a name that no workspace package, or several,
have, and an
`@sssb/*` package out of step with the framework's version, and it reports framework cutover rows your
`docs/cutover-checklist.md` never mentions. It also reports, never failing and never changing anything, the settings
only you can make: when `gh` is signed in, whether `sssb / all-checks` is a required check on your repository's default
branch (a ruleset or branch protection), whether private vulnerability reporting is on and, for a private repository
in an organization, whether its Actions policy lets it call SSSB's reusable workflow; and whether the Claude Code
plugin your `.claude/settings.json` enables is installed on this machine. These are read-only GitHub API requests
through `gh`; a missing or signed-out `gh`, no network, or a setting your account may not read gives "not checked"
and the reason. None of it runs when `CI` is set (a CI token cannot be relied on to read these settings, and a CI runner does not normally have Claude Code).
Inside SSSB's own repository it says "in-repo mode" and checks each app's
seam aliases instead of links. **`sssb check-e2e`** asks your own Playwright which files your configs load
(`playwright test --list`, which starts no server and needs no browser), bundles each, and fails, naming spec and
framework file, if a spec reaches the framework other than through `@sssb/kit/testing/e2e`, the one entry Node can
load; reaching it through your own domain module or a workspace package counts. A spec that reaches the framework's
TypeScript stops Playwright listing its config at all (Node will not load TypeScript under `node_modules`), so
check-e2e then fails the config with Playwright's error and names the framework file. A config Playwright cannot list,
or that lists no test, fails too; a config kept outside the app's directory is named with `--config <file>`.

## Layout

The workspace the generator writes, as far as you build in it:

```
apps/<app>/config/            APP_SLUG and (optionally) deployment params
apps/<app>/src/app/           Next route files (thin wrappers; framework routes live here too)
apps/<app>/src/app-config/    THE SEAM — your registrations
apps/<app>/src/components/    your screens/cards
apps/<app>/src/domain/        your domain modules (not generated: create it when you need it)
apps/<app>/src/ports/         your own ports, for a vendor SSSB has no port for (docs/recipes/app-owned-adapter.md; not generated)
apps/<app>/src/adapters/      their registry and fakes; adapters/real/ is the app's only vendor-SDK directory (not generated)
apps/<app>/src/demo-static/   your half of the file:// demo twin (the framework half is SSSB's)
apps/<app>/src/seed/          your seed world (fills in @sssb/kit/seed/contracts)
apps/<app>/messages/          your i18n namespaces (the framework ships its own catalog)
apps/<app>/tests/             your e2e, static-demo and contract specs
apps/<app>/infra/             the app's deployment: a CDK app holding SSSB's SssbApp construct (@sssb/cdk)
docs/cutover-checklist.md     what the app defers until it has real accounts
.claude/sssb-guide.md         SSSB's app guide, a stamped copy that `sssb guide` refreshes; CLAUDE.md imports it
.github/workflows/checks.yml  your CI, calling SSSB's reusable workflow at a pinned commit
```

The framework is not in the tree: it is `@sssb/kit` under `node_modules`, and you never edit it.

### What you may import from SSSB

`@sssb/kit`'s `exports` map (its `package.json`; `packages/kit/package.json` in SSSB's repository) is the contract: it
lists the 142 subpaths your app may
import as `@sssb/kit/<subpath>` (`@sssb/kit/ports/db`, `@sssb/kit/components/app-header`, `@sssb/kit/db/with-tenant`). The
other 75 modules of the package are internals — private sub-components, the fake-db plumbing, the test helpers, the
framework migrations, the real adapters the registry constructs for you, the authorization scan's
analyser — and importing one fails
`pnpm lint` with the rule `sssb/public-surface`, which reads that map directly. Your Playwright specs may import
less: Node loads a spec without your seam and without compiling anything under `node_modules`, so a spec reaches
SSSB only through `@sssb/kit/testing/e2e`, which ships compiled and seam-free (today, the webhook signature
verifier). A spec that needs one of your app's constants reads it from a module that imports nothing from SSSB
but types, as the showcase's pagination spec reads `apps/showcase/src/domain/ticket-page-size.ts`. If you find yourself
reaching for an internal, that is a signal the capability needs a seam, not a wider fence; if a module
really is part of the contract and merely has no importer yet, that is an SSSB change, which reaches you in a release
("Changing SSSB itself" below).

Nothing of yours reaches SSSB by file path. The two tools that need a file rather than a module specifier get it from
SSSB: your `next.config.ts` wraps its config in `withSssb` from `@sssb/tools/next`, which points next-intl at the
framework's request config, and the `SssbApp` construct (`@sssb/cdk`) resolves the migrator as
`@sssb/kit/adapters/real/migrate-handler` from the app's own directory and passes the app's seam to esbuild
explicitly. The app's `typecheck` covers `apps/<app>/infra/` (`tsc -p infra`), and `pnpm synth` synthesizes it.

### When a lint fence must let one of your modules through

Some fences take named exceptions. Today one does: `sssb/no-raw-db-handle`, which bans `getDb()` in every
module under your app's `src` (tests are exempt, except a route's or a screen's; tenant-scoped data goes through
`db.withTenant()`, ADR-0004). If a module of yours truly
needs the raw client, say a maintenance job that runs as the system across every tenant, list it in your app's
own `apps/<app>/lint-exceptions.mjs`. The fences themselves are `@sssb/eslint-plugin`, an installed package you never
edit, and switching one off in your `eslint.config.mjs` instead is exactly what `sssb check-fences` reports (below).

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

| Seam module                                   | You register                                                                                            | Empty looks like                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `abilities.ts`                                | subject types + staff org + credential kinds + person and machine (`appMachineAbilityRules`) rules      | (starter registers one)                    |
| `db/schema.ts`, `db/migrations/`              | your tables (`AppTables`) + migrations named `NNNN_name`, four digits, numbered ≥ 1001                  | (starter registers one)                    |
| `db/rls-proofs.ts`                            | tenant-isolation proofs for those tables                                                                | an empty async body                        |
| `jobs.ts`                                     | your background job kinds + handlers                                                                    | `[] as const`, `{}`                        |
| `digest.ts`                                   | the rows the framework's scheduled digest summarizes                                                    | `async () => []`                           |
| `actors.ts`                                   | your simulated counterparties for dev/demo                                                              | `actors = []`, `type ActorId = never`      |
| `simulator.ts`                                | your extra Simulator tabs + feature flags                                                               | `flags = []`                               |
| `presets.ts`                                  | demo presets (`/sssb:new-preset`): starting worlds every host can load, and your own kinds' definitions | `presets = []`, `appPresetOperations = []` |
| `preset-operations.ts`                        | server halves of your own preset operation kinds (`/sssb:new-preset-operation`)                         | `{}`                                       |
| `tours.ts`                                    | scripted Simulator walkthroughs of your product                                                         | `tours = []` (no Tours tab)                |
| `notifications.ts`, `webhooks.ts`, `audit.ts` | your event vocabularies                                                                                 | `[] as const` / `never`                    |
| `inbound-email.ts`                            | your `<org>+<slug>@domain` email handlers                                                               | `{}`                                       |
| `assistant.ts`                                | your LLM tools + system prompt                                                                          | omit the module and its route              |
| `messages.ts`                                 | your i18n namespaces + catalog loader (partitioned)                                                     | (every app registers some)                 |
| `identity.ts`                                 | `APP_SLUG`, re-exported from the app's app config                                                       | (every app registers it)                   |
| `seed.ts`                                     | your seed data re-export                                                                                | (every app registers it)                   |

An app with no extra subject fields writes `export type AppSubjectFields = Record<never, never>` in `abilities.ts`, as
`apps/starter` does: the framework's `AbilitySubject` intersects it, so it may be an interface, a type alias or a mapped type.

**To add a feature slice**: run `/sssb:new-slice` (and the per-capability scaffolds `/sssb:new-entity`,
`/sssb:new-job`, `/sssb:new-actor`, `/sssb:new-notification-kind`, `/sssb:new-webhook-event`, `/sssb:new-tour`,
`/sssb:new-preset`, `/sssb:new-preset-operation`: SSSB's Claude Code plugin). Each walks the house way:
screen in your app's `apps/<app>/src/components`, thin route, seam registrations, an RLS migration copied from the
reference (`apps/<app>/src/app-config/db/migrations/1001_items.ts`, the starter's), colocated tests, e2e, then
`pnpm verify` + `pnpm test:contract`. Each command is a markdown file in SSSB's `plugins/sssb/commands/`
(`new-slice.md`, say), which reads as step-by-step instructions without Claude Code. A screen generic enough for every app on SSSB belongs in the framework, which is
an SSSB change ("Changing SSSB itself" below).

**To remove the Items slice**: `pnpm exec sssb remove-items` from the app's directory (or `--app apps/<app>`), after
`--dry-run` has told you what it will do. It takes out the card, the route, the query, the ability, the catalog namespace, the
dashboard's and the static demo's card and the specs that name Items (the Simulator's e2e spec stays); the
app typechecks, lints and passes its conformance suite afterwards, which `pack-and-consume` proves on every change. The
migrations are the one decision it leaves to you: `--drop-migrations` also removes `1001_items`, `1002_items_keyset_index`, the
table's type and its RLS proofs, which is right only for a database that never ran them (delete `apps/<app>/.data`, and your
first table is `1001_<name>`). Without the flag they stay, registered, because a database records each migration it runs and
the migrator refuses to start when one it recorded is gone. The choice is made once: the command does not take the database half
later. It refuses, naming each file and changing nothing, when a file is not what the starter wrote (you edited the card, or removed
the route by hand): finish by hand from the list below, or restore the file and run it again. An unused framework capability
needs nothing: an empty registration is the off switch (`AppSubjectType = never`, an empty `appMigrations`, an empty proofs body
and `Record<never, never>` for `AppTables`, with `pnpm test:contract` then running only the framework's half).

**To remove any other slice** (one you built, or the showcase's): delete its card + routes +
`apps/<app>/src/domain/` module, if it has one + seam entries (ability case, table, migration, message namespace and its
`APP_NAMESPACES` entry in `apps/<app>/src/app-config/messages.ts`, vocabulary entries) and its e2e specs, then update the static twin (`apps/<app>/src/demo-static/app.tsx`) and run the
full gate. A slice that other seam entries reference (a job, an inbound handler or an assistant tool, as the
showcase's tickets are) has those entries replaced in the same change. An unused framework capability needs nothing:
an empty registration is the off switch.

**Static demo parity**: every slice ships its in-memory twin so the single-file `file://` demo keeps
walking end-to-end. You only write your DOMAIN half — `apps/<app>/src/demo-static/app.tsx` is a
composition root that adds your rows and cards to the framework world `@sssb/kit/demo-static` already
simulates (people, mail, jobs, schedules, webhooks, notifications, agreements, audit, snapshots). For one
table that is under a hundred lines; the showcase's, with three entities plus actors and the assistant, is over six
hundred.
Budget-gated per app (`pnpm check:demo-size`, each app passing its own byte budget). The starter's is
the number you inherit, sized for YOUR growth (room to grow to the showcase's size), and it is yours to
re-set in `apps/<app>/package.json`, with the reason recorded in `apps/<app>/DEMO-SIZE.md` beside it; the
source of `sssb check-demo-size` (`packages/tools/src/commands/check-demo-size.js`, SSSB's, never yours to edit) says what it guards and what to do when
it goes red. The demo's build also drops every Mantine style rule no shipped component can
match (`packages/tools/src/prune-mantine-css.js`, inside the `@sssb/tools/vite` preset), so a Mantine component you add needs no CSS import. The same file is
the ONLY door for your shell, too: the `nav`, `welcome` and `dashboard` it passes `DemoShell` are what
the demo shows, so a navigation you build for the real app is absent from the twin until you pass it
there.

**Why the seam holds for an app SSSB has never seen**: in SSSB's repository, `apps/starter/tsconfig.json` includes
the whole of `packages/kit/src` (minus tests and stories), so `pnpm typecheck` there compiles the ENTIRE framework
against the starter's registrations — a framework module that assumed the showcase's tables or
vocabulary fails there and nowhere else. `apps/starter/src/sssb.conformance.test.ts` then runs SSSB's
conformance suite a second time, under the starter's aliases, and every release is gated on both apps and on a
workspace generated from the packed packages. Each check was watched failing before being trusted.

## The scheduled tick

SSSB's recurring work only advances when something ticks it. `job_schedules` (a digest, a reminder) and outbound
webhook retries are drained by one function, `runScheduledTick` (`@sssb/kit/server-lib/scheduled-tick`), and the route
that calls it lives in the app you keep: `apps/<app>/src/app/api/webhooks/cron/route.ts`,
`export const POST = withWebhookSecret(…)`. The generator writes it with the rest of the app and nothing deletes it;
the showcase carries the same route over the same function.

- **Who may call it** is a machine, not a person. The route is guarded by the shared webhook secret, sent in
  `x-sssb-webhook-secret` (compared in constant time; anything else is an opaque 401 before the tick runs).
  `Authorization: Bearer …` is accepted too when that header is absent, but never send it through your deployment's
  public host: CloudFront signs every request it passes to the server's Function URL, and its signature replaces the
  `Authorization` header, so the route would answer 401. The same holds for a service token (`verifyServiceCaller`),
  which goes in `x-sssb-service-token`. The
  authorization scan (the conformance suite's `authz-mutations` check) exempts a `webhooks/` route only if its handler
  is the `withWebhookSecret(…)` call, so if you edit the route keep that wrapper, and keep the logic in SSSB's function.
- **In a deployment** `SssbApp` (`@sssb/cdk`) ticks it when you pass `scheduledTick: { webhookSecret }`, the secret
  your server's `WEBHOOK_SECRET` holds, as a plain string: an EventBridge rule every five minutes (`every` changes it)
  runs a small function that reads the secret and invokes your server with a POST of this route. It invokes the server
  directly, not through CloudFront or the Function URL, and the route checks the secret as it does for any caller. The
  construct never puts the secret's value in an environment, so getting it into the server's `WEBHOOK_SECRET` is
  yours, as for your other secrets. Without the option nothing in a deployment ticks the route: the `scheduled-tick`
  row of the [cutover checklist](cutover-checklist.md).
- **In `pnpm dev`** nothing ticks it unless you ask. The dev server runs no scheduler. Its Simulator panel's Jobs tab
  advances the world clock and runs what is then due, or runs what is due without moving it, once per click. To run
  the route itself, three ways to ask:
    - **`pnpm tick`** calls the running dev server's route once and prints what ran (`pnpm tick:starter` for the starter
      beside the showcase in SSSB's repository; in a workspace the generator writes, `pnpm tick` is your app). It exits 1 if the server is
      down, rejects the secret or answers an error, and 2 for a bad command line. It authenticates as any caller must: it
      reads the per-checkout dev secret from `apps/<app>/.data/auth/webhook-secret` (the first request to a server creates
      the file, so a missing one is made that way) and sends it in `x-sssb-webhook-secret`. It adds nothing to the route and cannot
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
      that one is running and leaves it to be stopped where it was started. Your app's Simulator has no such control; the
      route is the showcase's app code, and an app that wants one copies it.

    The answer is `{"ok":true,"spawned":0,"failed":0,"deliveries":{…}}`, which `pnpm tick` prints as one line. In a
    simulated world "now" is the Simulator's world clock (real time plus whatever offset a demo advanced), so a tick
    honours a clock a demo moved. A schedule whose spawn failed, or a delivery that failed, shows in that line and is
    retried by the next tick: the tick itself succeeded, so the exit code stays 0.

## Cutover — from hermetic to real

Everything needing credentials, accounts or money is a row in your workspace's `docs/cutover-checklist.md` —
**that file is yours**, written by the generator with SSSB's rows (the ones essentially every instance needs) and
waiting for your owners, dates and proofs. The pattern, from SSSB's own
[cutover-checklist.md](cutover-checklist.md):

> **Row** = item name · what it is · what unlocks it · the exact verification that was deferred.

The last column is the one that matters. Until a row's proof is met, the related real adapter is
_authored but unverified_ — it compiles, it has a fake that everything else runs on, and nobody has ever
watched it talk to the real thing. Keep the discipline when you add rows: **name the proof, not just the
task.** "Set up email" is a task; "a real send through the email port with DKIM/SPF verified on the
domain" is a proof.

SSSB's file opens with a worked row — closed, dated, owned, with a proof column that was thought through
rather than restated. Read it once for the level of detail each row deserves before you fill in your own.

### Ports your app does not use

Real mode requires the settings of SSSB's optional ports only for the ones your app uses. Declare them in
`apps/<app>/config/params.ts`, under `ports`: `llm` (`anthropic` or `none`), `email` (`mailgun` or `none`),
`inboundEmail` (`mailgun` or `none`), `jobs` (`codebuild`, `in-process` or `none`) and `storage` (`s3` or `none`).
`SssbApp` sets each as the server's switch (`LLM_PROVIDER`, `EMAIL_PROVIDER`, `INBOUND_EMAIL_PROVIDER`, `JOBS_RUNNER`,
`STORAGE_PROVIDER`); a deployment of your own, or `pnpm dev:real`, sets the variables itself. An unset switch takes its
first value, which is what real mode required before the switches existed.

- **`none` makes the port absent.** Its settings are not required, its SDK is never loaded, its cutover rows do not
  apply, and a call through it throws an error that names the switch. Never fill an unused port's settings with
  placeholder values instead: the placeholder reaches the vendor and fails there, far from the cause. `email: 'none'`
  turns off SSSB's own mail too: an invitation or a notification is still created, and its email, sent after the
  response, fails there (recorded as a `deferred_work_failed` analytics event and a `SSSB deferred work … failed` log line) instead of sending.
- **`storage: 'none'` needs no S3 bucket.** Real mode then requires neither `STORAGE_BUCKET` nor, unless the Data API
  transport or the CodeBuild runner needs it, `AWS_REGION`, and `SssbApp` builds no storage bucket and grants the server
  no S3 access. SSSB itself stores nothing; your app's uploads, attachments and job artifacts do, and each call
  through the absent port throws, a job handler's too (on `jobs: 'in-process'` the job is recorded `failed` with that
  message). Switching
  a deployed stack from `s3` to `none` takes the bucket out of the stack: a `production: true` deployment retains it,
  with its objects, outside the stack; any other deletes it and everything in it, as deleting the stack would. Copy
  out what you need first. Switching back builds a new, empty bucket under the same logical id, never the old one.
- **`jobs: 'in-process'` needs no CodeBuild project.** Each job's handler runs in the server, from the request or the
  scheduled tick that started it, and its status is recorded before that call returns. It shares that invocation's
  time limit (30 seconds on `SssbApp`), so work that may outrun it belongs on `codebuild`, which runs each job as a
  build and records its end through a jobs webhook route. Scheduled jobs then need only the scheduled tick (above).

The starter declares `llm: 'none'`, `inboundEmail: 'none'`, `jobs: 'in-process'` and `storage: 'none'`: it makes no
model call, has no inbound email route, no jobs webhook route and stores no files.

**SSSB needs Postgres 16 or later.** Framework migration
`packages/kit/src/db/migrations/0015_app_user_grant.ts` lets the migrating role switch to `app_user`
with `GRANT … WITH SET TRUE`, checked by `pg_has_role(…, 'SET')`. Both arrived in Postgres 16, so on an
older server that migration cannot run. Everything SSSB targets already meets it: the Aurora cluster in
`packages/cdk/src/sssb-app.js` (16.10), CI's contract job (`postgres:16` in `.github/workflows/app-checks.yml`), pglite
(18.6) and the embedded Postgres that a local `pnpm test:contract` starts (18.4).

### What `SssbApp`'s distribution decides for you

The CloudFront distribution in front of your server makes four choices you deploy with. The reasons, and what was
rejected, are in SSSB's decision log (its 2026-11-19 entries on `SssbApp`), and for the body hash in ADR-0001's
addendum of that date.

- **Region.** A Lambda@Edge function on each request to the server adds the body hash a `POST` needs to reach the
  Function URL, and Lambda@Edge lives in us-east-1 only.
    - An environment-agnostic stack, as the starter's is, therefore deploys to us-east-1 only.
    - For any other region, give the stack an explicit `env`. The construct then puts that function in a us-east-1
      stack of its own, `edge-<region>-…`, carrying your stack's tags, so bootstrap us-east-1 too.
    - Deploy by naming your stack, which deploys that one first, or with `--all`.
    - A request body is capped at 1 MB; a larger one answers 413.
- **The visitor's host.** CloudFront sends the server the Function URL's own `Host`. A CloudFront Function therefore
  sets `x-forwarded-host` (and `x-forwarded-port`) from the request the visitor made, overwriting anything the visitor
  sent. Clerk, Next's server-action origin check and next-intl read it. Next's own `request.url` does not: it names the
  server's own address (`localhost` and its port). So build an absolute URL for a visitor from the forwarded headers,
  never from `request.url`.
- **HTTPS and security headers.** Every behavior redirects HTTP to HTTPS and carries AWS's managed
  SecurityHeadersPolicy:
    - HSTS for a year;
    - `nosniff`, always sent;
    - `Referrer-Policy: strict-origin-when-cross-origin`;
    - `X-Frame-Options: SAMEORIGIN`.

    Each yields to a header your app sends, but nosniff. Before your first deploy, check three things:
    - **Framing.** If another site frames your app, send a CSP `frame-ancestors` naming it from the app.
    - **Content types.** Your pipeline must upload the static files with their real `Content-Type`, or a browser refuses
      a script stored as something else.
    - **Subdomains.** `hstsIncludeSubdomains: true` adds `includeSubDomains` once every subdomain of your domain serves
      HTTPS.

    A policy of your own, as `responseHeadersPolicy`, replaces the whole set.

- **A behavior you add.** A behavior you add to `sssbApp.distribution` gets none of this unless you give it all three:
    - `viewerProtocolPolicy: REDIRECT_TO_HTTPS`;
    - `responseHeadersPolicy: sssbApp.responseHeadersPolicy`;
    - for one that reaches the server, `sssbApp.forwardedHost` on `viewer-request`.

## Upgrading, step by step

SSSB's packages are released together, at one version, from `main` in SSSB's repository, and nothing is backported: a
fix arrives in the next release (ADR-0014 part 10). While the version is 0.x, a minor (0.2 to 0.3) is where breaking
changes go and a patch is compatible. Each release is published to npm and tagged `v<version>` in
`safeinsights/sssb`, and its notes are in SSSB's repository, under `docs/releases/` (`docs/releases/v0.2.0.md`, say).

An upgrade is one change in your repository, made on a branch like any other. Every release's notes open with the
section "Upgrading to this release", which carries steps 2 to 6 below as commands, with that release's version
in them. The steps say why each is there:

1. **Read the notes of every release after yours, in order.** Every entry sits in one of four sections, which are always there ("Seam changes", "Framework migrations", "Operator
   actions", "Scaffold changes to apply by hand"), or under "Other changes", and says whether its action is required,
   optional or none, what changed, what to do ("To adopt") and the local code it makes deletable ("Now deletable").
2. **Move every `@sssb/*` package to the new version, together.** Each package of the workspace that uses one
   declares it: the root `package.json` (`@sssb/tools`), `apps/<app>/package.json` (`@sssb/kit`, `@sssb/tools`,
   `@sssb/eslint-plugin`) and `apps/<app>/infra/package.json` (`@sssb/cdk`, `@sssb/tools`), plus any package of your
   own that took one, and a root `@sssb/create` if you installed one for `sssb add-app`. **First make any "Scaffold
   changes to apply by hand" entry that touches how the packages install**, or the install keeps the old release. Then
   `pnpm install`, check that the lockfile resolves each package to the new release, and commit the lockfile.
   `sssb doctor` names the `@sssb/kit` version it found in its
   opening lines, and fails when the `@sssb/*` packages the app resolves (`@sssb/kit`, `@sssb/tools`,
   `@sssb/eslint-plugin`) are not all at one version; `@sssb/cdk` and the infra's `@sssb/tools` are checked when
   `SssbApp` synthesizes, which refuses a version other than its own.
3. **Refresh the app guide's copy**: `pnpm exec sssb guide` from the workspace root, then read the diff of
   `.claude/sssb-guide.md`. Those are the rules every agent in your repository follows, and they change only through
   a diff of your own; `sssb doctor` fails until the copy is the installed kit's.
4. **Raise both pins to the release commit**, the commit of SSSB's repository the release was cut from: `pnpm exec sssb pin`
   from the workspace root (after the install in step 2, which brings the kit it reads). Your CI's `sssb` job calls SSSB's
   reusable workflow at one pin (`.github/workflows/checks.yml`, `uses: safeinsights/sssb/.github/workflows/app-checks.yml@<commit>`,
   and the version in the comment after it) and your Claude Code plugin loads from SSSB's marketplace at the other
   (`.claude/settings.json`, the `sssb` marketplace's `ref`), so a pin left behind runs the old release's checks and commands
   against the new packages. The installed kit records the commit as `commit` in its `dist/release.json`, and the command
   writes it to both, printing each pin it changed with the commit it replaced; run again, it changes nothing. It edits the
   two files' text and nothing else in them but the version in a workflow comment (`# @sssb/create 0.2.0`, `# v0.2.0`) after the pin. It refuses, and writes nothing, when there is no commit to read (SSSB's own
   repository, where the kit is source, or a kit packed by hand without a stamp) or when a file is not the shape it
   edits: no workflow calls SSSB's reusable workflow, or `.claude/settings.json` is not JSON or declares no marketplace
   from SSSB's repository. When it refuses, make the two edits by hand, to the release's commit: the one `sssb doctor` names beside a pin that differs, or, for a kit with no stamp,
   which doctor cannot compare, the one the release's tag `v<version>` names; the pin takes the SHA, never the tag. A workspace with no `.claude/settings.json` has no second pin, and the command raises
   the first alone. Then each person updates their installed plugin: `claude plugin marketplace update sssb`, then
   `claude plugin update sssb@sssb --scope project`, and restarts Claude Code (the update applies on restart).
5. **Apply each entry's "To adopt"**, section by section:
    - **Seam changes**: what your app must say or satisfy to build (next section). `pnpm typecheck` and `pnpm lint`
      point at most of them, the conformance suite and `sssb doctor` at the rest.
    - **Framework migrations**: they run with your app's own migrations, in order; an entry says what to order
      around or do before you deploy.
    - **Operator actions**: what whoever deploys does (a parameter, an environment variable, a secret, an IAM
      permission, a resource replaced), with any new cutover row for `docs/cutover-checklist.md`; `sssb doctor`
      reports a framework row the file does not mention.
    - **Scaffold changes to apply by hand**: changes to files `@sssb/create` wrote once, which no release touches
      (the CI caller, the gitleaks rules, the root config). You make them.

    Then delete what each entry's "Now deletable" describes, wherever your tree has it, and run `pnpm knip`: a vendor
    SDK (`@aws-sdk/client-s3`, say) that your app listed only for code you deleted is now flagged as unused, because
    the kit's adapter that replaces it carries its own copy. Remove it from the `package.json` that lists it, unless
    other code still imports it.

6. **Check, then push**: `pnpm exec sssb doctor`, which fails on versions out of step, a second copy of a peer and
   a stale guide copy, and only REPORTS a pin that is not the release commit or a framework cutover row your
   checklist does not mention: read its `report` lines, not just its last one. Then `pnpm verify`. CI then runs
   SSSB's checks at the new pin.

A release that turns your
app red with no entry saying why is a bug in its notes: report it in SSSB's repository.

### When a release changes what your seam must say

"Seam changes" is the section that can stop your app compiling: a new required export in an `app-config` module, an
`exports` removal, a raised peer floor, or a lint rule, conformance check, `sssb doctor` check or tsconfig option that
newly fails app code (ADR-0014 part 10 lists what counts as breaking). Its entries say exactly what to add. `tsc`, `pnpm lint`, the conformance suite or
`sssb doctor` points at each place. A workspace generated at a release
already says what that release's seam asks.

## Changing SSSB itself

Your workspace never carries a change to SSSB's packages. A fix or a capability that belongs in the framework, the
tools, the fences, the construct or the plugin is a pull request (or first, for a capability, a capability request)
in SSSB's repository, where it is built and tested against both of SSSB's apps and a generated workspace
(`CONTRIBUTING.md` there), and it reaches you in the next release. If you cannot wait, `pnpm patch` can carry it in
your workspace meanwhile; remove the patch when you upgrade to the release that has the fix. Something that only your
app needs is not an SSSB change at all: it lives in your app (`docs/recipes/app-owned-adapter.md` for a vendor SSSB
has no port for).

### Trying an unreleased commit of SSSB

To try a commit no release carries yet, run the generator from a checkout of SSSB against SSSB's packages packed into a
directory:

```sh
# in a checkout of SSSB, installed (the kit's prepack builds with its devDependencies)
for p in kit tools eslint-plugin cdk; do pnpm --dir packages/$p pack --pack-destination ~/sssb-tarballs; done
node packages/create/bin/create.js ~/acme --sssb ~/sssb-tarballs --name "Acme Research" \
    --repo acme-org/acme-research --owner @acme-org/devs
```

- **The template is the files git tracks in the checkout's `apps/starter`, as they are in its working tree.** A
  generator with no packed `template/` (one run from a checkout) builds it from that checkout first, so an
  uncommitted edit to a tracked file is in your app, and a file git does not track is left out, with a warning naming
  it (`git add` it to include it). A symlink or submodule there, or a tracked file missing from the working tree, stops
  the build.
- **The workflow pin is the checkout's `HEAD`**, which must hold `.github/workflows/app-checks.yml`. Your CI's
  `uses:` line resolves only if that commit is on GitHub: push it, or pass `--workflow-ref <sha>` naming one that
  is. Run from a checkout, the generator warns when no remote-tracking branch of a remote at `safeinsights/sssb`
  holds the commit (as of your last fetch). A packed generator pins the commit it was packed from, and packing it
  refuses a commit that is not on such a branch, or an `apps/starter` or app guide that differs from that commit
  (`SSSB_CREATE_UNPUSHED_PIN=1` turns both into warnings, for a tarball no workspace will run on GitHub). Packing
  `@sssb/kit` likewise refuses shipped sources (`packages/kit/src`, its `package.json`) that differ from `HEAD`,
  because it stamps that commit into `dist/release.json`; the same variable turns that refusal into a warning.
- **`--sssb <dir>` wants exactly one `sssb-<package>-<version>.tgz` for each of `kit`, `tools`, `eslint-plugin`
  and `cdk`, all of the generator's own version** (`packages/create/package.json`'s). The workspace depends on them
  by absolute `file:` path, in each package that takes one, and needs no `overrides`: no SSSB package depends on
  another (`@sssb/tools` is a peer of `@sssb/cdk`, which `apps/<app>/infra/` installs beside it). Such a workspace is
  for trying the commit on your machine; generate the one you keep from a release.

## Keeping the docs honest

The docs in your workspace are yours: `README.md`, `CLAUDE.md` (your own rules, below the line that imports SSSB's
guide), `docs/cutover-checklist.md` and `apps/<app>/DEMO-SIZE.md`. SSSB's doc set (the adoption guide and this reference, the ADRs, the recipes,
the runbooks, and its dated records) stays in SSSB's repository, mapped in [docs/README.md](README.md); the generator
copies none of it but the app guide (`.claude/sssb-guide.md`), so read it there, at the release you are on.

The habits worth taking with you: record unplanned decisions and hard-won lessons as they happen (SSSB keeps
`docs/decision-log.md` and `docs/build-notes.md`, append-only, and a file of your own does the same job); amend a
decision by appending a dated note, never by editing what it said; run the plugin's `sssb:doc-steward` agent on a
branch diff before a PR; and `/sssb:pre-pr` runs the verify gate plus a branch review. `CLAUDE.md` teaches all of this
to agent sessions: keep it current as your product diverges.
