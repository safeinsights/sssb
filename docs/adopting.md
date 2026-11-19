# Adopting SSSB

This guide takes a new app from nothing to deployed and upgraded, in the order you act. SSSB arrives as packages
(`@sssb/kit` the framework, `@sssb/tools` the `sssb` command and presets, `@sssb/eslint-plugin` the lint fences,
`@sssb/cdk` the deployment construct), plus a CI workflow and a Claude Code plugin pinned to the same release. Your
repository holds your app. Everything this guide leaves out is in [the reference](adopting-reference.md).

## 1. Generate the workspace

```sh
pnpm create @sssb acme --name "Acme Research" --repo acme-org/acme-research --owner @acme-org/devs
cd acme
git init                                                    # before the install, whose `prepare` sets up git hooks
pnpm install
pnpm --filter './apps/*' exec playwright install chromium   # once, for the e2e suites
pnpm verify                                                 # what CI runs, offline: no docker, no credentials
```

With npm, the options follow a `--`: `npm create @sssb acme -- --name "Acme Research"`. Your app is under `apps/`, in a
directory named for its slug (`acme` here), a renamed copy of SSSB's starter app (`apps/<app>/` below); the workspace
around it holds its config, its CI and its cutover checklist. Every option, refusal and file is in the reference, "`pnpm
create @sssb`".

Keep a checkout of SSSB's repository beside your own. Its showcase app (`apps/showcase`) is a working example of every
capability, and the one you will read most in your first week. To see every capability working first, run the demo tour
there ([runbooks/demo.md](runbooks/demo.md)), or open the showcase's single-file demo that SSSB's README links from its
latest release.

## 2. First boot

`pnpm dev` starts your app seeded and offline, with no accounts. It serves on port 3700, its own port slot (`ACME_PORT`
overrides it). Sign in as any seeded person from the picker. In development the app carries SSSB's Simulator panel:
People (become anyone), Mail (every email the app sent) and Jobs (background work, and a world clock you can move
forward). `pnpm build:demo-static` builds the same app as one HTML file, `apps/<app>/dist-demo/index.html`, that runs
from disk with no server.

Then create the repository on GitHub (the `--repo` you named), add it as `origin` and push. Make the settings only you
can make: require the check `sssb / all-checks` (and `workspace-checks` and `secret-scan`) on your default branch, turn
on private vulnerability reporting, and, for a private repository in an organization, allow public reusable workflows.
`pnpm sssb:doctor` checks the install, and reports which of those settings are still missing once `origin` is on GitHub
and `gh` is signed in. SSSB's commands for Claude Code (`/sssb:new-entity` and the rest) need Claude Code 2.1.324 or
later: after trusting the folder, each person runs `claude plugin install sssb@sssb --scope project` once per clone.
Without Claude Code, each command is a file of plain instructions in SSSB's `plugins/sssb/commands/`.

## 3. Take out the starter's content

**Tenants, teams and people** come first, because the starter's world is made of them and so is yours:

- A **tenant** is one customer's separate site: its own sign-in, its own branding, its own data. It is the boundary SSSB
  isolates hard. Each table of yours that holds a tenant's data carries `tenant_id`, Postgres row-level security keeps
  each tenant's rows invisible to every other tenant, and your queries run inside `db.withTenant()`, which sets the
  tenant for them.
- An **organization**, which the product calls a **team**, is a group of people inside one tenant who work together. A
  team's slug is unique across the whole app. Data that belongs to a team carries an `org_id`, and your queries filter
  on it inside `withTenant`. It is not a security boundary: row-level security stays per tenant.
- A **person** belongs to one tenant and has a role in each of their teams: `admin`, `staff`, `member`, `guest` or
  `restricted`. A person marked `restricted` sees a reduced set of features.
- The **staff team** (`staffOrgSlug`) is one team, your operators': a member acting as it may manage everything in its
  tenant, and never in another. Your routes decide what that reaches: one that filters by the active team, as Items'
  does, shows staff their own team's rows.

Your app still shows the starter's world: two tenants, a team in each, three people, and an Items list on the dashboard.
Read the Items slice first (the reference, "The starter's content is still wired into your UI", lists its files), and
keep its migration `1001_items.ts` and its keyset index `1002_items_keyset_index.ts` open: they are the pattern for your
first table. Then take Items out in one step, from `apps/<app>`:

```sh
pnpm exec sssb remove-items --drop-migrations --dry-run   # says what it will change
pnpm exec sssb remove-items --drop-migrations
rm -rf .data                                              # the local database still holds the Items migrations
```

`--drop-migrations` is right only for a database that never ran Items' migrations, which is true of a workspace you just
generated. The removed files stay readable in SSSB's repository at the commit your workspace pins (the `@<commit>` of
the `uses:` line in `.github/workflows/checks.yml`), under `apps/starter/`.

Then replace the seed world in `apps/<app>/src/seed/index.ts` with your own, rather than adding yours beside it: every
sign-in picker lists all of it. `staffOrgSlug` in `apps/<app>/src/app-config/abilities.ts` must name one of your teams,
and the specs that sign in by a person's id, `apps/<app>/tests/e2e/simulator.spec.ts` and
`apps/<app>/tests/demo-static/static-shell.spec.ts`, must name yours. The welcome copy is `welcome.subtitle` in
`apps/<app>/messages/en.json` and `apps/<app>/messages/es.json`.

## 4. Your first entity

An entity touches these files, in this order (`/sssb:new-entity` walks them, and `/sssb:new-slice` adds the screen):

1. **The table**: a migration `apps/<app>/src/app-config/db/migrations/1001_<name>.ts`, copying Items' row-level
   security policy, with the keyset index a paged list needs (`1002_items_keyset_index.ts` says which), listed in that
   directory's `index.ts`; its row type in `AppTables`, `apps/<app>/src/app-config/db/schema.ts`.
2. **Its proofs**: a section in `apps/<app>/src/app-config/db/rls-proofs.ts` showing each of two tenants cannot read or
   write the other's rows. The runner hands you both tenants.
3. **Who may do what**: the subject and its rules in `apps/<app>/src/app-config/abilities.ts`, with a test beside it
   (`abilities.test.ts`). Everything is denied unless a rule allows it.
4. **Its queries**: `apps/<app>/src/domain/db/<name>.ts` (create the directory), inside `db.withTenant()`. A list that
   can grow pages with `@sssb/kit/db/keyset`.
5. **Its routes**: `apps/<app>/src/app/api/<name>/route.ts`, and `[id]/route.ts` beside it for one row. Every handler
   that changes data calls `authorize(...)`.
6. **Its screen**: a card in `apps/<app>/src/components/`, added to the dashboard by
   `apps/<app>/src/app/[locale]/(protected)/dashboard/page.tsx` (which works out what the person may do) and
   `dashboard-glue.tsx` beside it.
7. **Its words**: a namespace in `apps/<app>/messages/en.json` and `apps/<app>/messages/es.json`, named in
   `APP_NAMESPACES` (`apps/<app>/src/app-config/messages.ts`). No UI string is written in code.
8. **The static demo**: its rows and card in `apps/<app>/src/demo-static/app.tsx`.
9. **Its tests**: unit tests beside the code, and an e2e spec in `apps/<app>/tests/e2e/`.

Then `pnpm verify` from the workspace root, which runs the contract tests on real Postgres too (`pnpm lint:fix` formats
what it flags). The reference, "Building your product", has the whole seam: jobs, notifications, webhooks, presets and
the rest.

## 5. Deploy and cut over

`apps/<app>/infra/app.ts` is a CDK app holding `SssbApp` (`@sssb/cdk`): the server on Lambda behind CloudFront, Aurora
Postgres, the migrator, alarms and a budget. `pnpm synth` checks it offline. Before a first deploy:

- **Fill in `apps/<app>/config/params.ts`.** Each `PLACEHOLDER_` there names the cutover row that fills it.
- **Choose your optional ports** in its `ports`: `llm`, `email`, `inboundEmail` and `jobs`. `none` leaves a port out, so
  real mode needs none of its settings. Never fill an unused port's settings with placeholders.
- **Turn on the scheduled tick.** Recurring work (digests, reminders) and webhook retries only run when something calls
  your app's cron route. Pass `scheduledTick: { webhookSecret }` to `SssbApp`, where `webhookSecret` is the Secrets
  Manager secret (an `ISecret`) holding the same plain-string value as your server's `WEBHOOK_SECRET`, and the route is
  called every five minutes. The construct never puts a secret's value on the server: setting `WEBHOOK_SECRET` there is
  yours, as for your other secrets (the cutover row `scheduled-tick`). In development, `pnpm tick` calls it once.
- **Work through `docs/cutover-checklist.md`.** Each row is something that needs a real account, and the proof that
  closes it. `pnpm sssb:doctor` reports a framework row the file stops mentioning.

`apps/<app>/infra/README.md` is the deployment's own guide (region, network shapes, what synth checks). The reference,
"Cutover", has the rest.

## Upgrading by release

SSSB's packages are released together, at one version. A release's notes (under `docs/releases/` in SSSB's repository)
open with "Upgrading to this release", which gives steps 2 to 6 below as commands, with that release's version:

1. **Read the notes of every release after yours.** Each entry says what changed, whether you must act, and what to do.
2. **Move every `@sssb/*` package to the new version together** (the root's `package.json`, `apps/<app>/package.json`
   and `apps/<app>/infra/package.json`), then `pnpm install`. `sssb doctor` fails on packages out of step.
3. **`pnpm exec sssb guide`** refreshes `.claude/sssb-guide.md`, the rules your agents follow, so their change reaches
   your diff.
4. **`pnpm exec sssb pin`** raises your CI workflow's pin and your plugin's to the release's commit. Then each person
   runs `claude plugin marketplace update sssb` and `claude plugin update sssb@sssb --scope project`, and restarts
   Claude Code.
5. **Apply each entry's "To adopt"**, delete what its "Now deletable" names, then run `pnpm knip`.
6. **`pnpm exec sssb doctor`, then `pnpm verify`**, then push.

The reference, "Upgrading, step by step", says why each step is there. A release that turns your app red with no entry
saying why is a bug in its notes: report it in SSSB's repository.
