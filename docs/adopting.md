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
capability, and the one you will read most in your first week.

## 2. First boot

`pnpm dev` starts your app seeded and offline, with no accounts. It serves on port 3700, its own port slot (`ACME_PORT`
overrides it). Sign in as any seeded person from the picker. In development the app carries SSSB's Simulator panel:
People (become anyone), Mail (every email the app sent) and Jobs (background work, and a world clock you can move
forward). `pnpm build:demo-static` builds the same app as one HTML file, `apps/<app>/dist-demo/index.html`, that runs
from disk with no server.

Then push, and make the settings only you can make: require the check `sssb / all-checks` (and `workspace-checks` and
`secret-scan`) on your default branch, turn on private vulnerability reporting, and, for a private repository in an
organization, allow public reusable workflows. Each person runs `claude plugin install sssb@sssb --scope project` once
per clone for SSSB's commands (`/sssb:new-entity` and the rest). `pnpm sssb:doctor` checks the install and reports which
of those settings are still missing.

## 3. Take out the starter's content

Your app still shows the starter's world: two tenants, a team in each, three people, and an Items list on the dashboard.
Read the Items slice once, because it is the worked example for everything below. Then take it out in one step, from
`apps/<app>`:

```sh
pnpm exec sssb remove-items --drop-migrations --dry-run   # says what it will change
pnpm exec sssb remove-items --drop-migrations
rm -rf .data                                              # the local database still holds the Items migrations
```

`--drop-migrations` is right only for a database that never ran Items' migrations, which is true of a workspace you just
generated. Then replace the seed world in `apps/<app>/src/seed/index.ts` with your own, rather than adding yours beside
it: every sign-in picker lists all of it. `staffOrgSlug` in `apps/<app>/src/app-config/abilities.ts` must name one of
your teams, and the specs that sign in by a person's id must name yours. The welcome copy is `welcome.subtitle` in
`apps/<app>/messages/en.json` and `apps/<app>/messages/es.json`. The reference, "The starter's content is still wired
into your UI", lists each piece.

## 4. Your first entity

Three words first, because every table needs them:

- A **tenant** is one customer's separate site: its own sign-in, its own branding, its own data. It is the boundary SSSB
  isolates hard. Each table of yours that holds a tenant's data carries `tenant_id`, Postgres row-level security keeps
  each tenant's rows invisible to every other tenant, and your queries run inside `db.withTenant()`, which sets the
  tenant for them.
- An **organization**, which the product calls a **team**, is a group of people inside one tenant who work together. A
  person belongs to one tenant and has a role in each of their teams. Data that belongs to a team carries an `org_id`,
  and your query filters on it inside `withTenant`. It is not a security boundary: row-level security stays per tenant.
- The **staff team** (`staffOrgSlug`) is your operators' team: a member acting as it may manage everything in their own
  tenant, and never in another.

An entity touches these files, in this order (`/sssb:new-entity` walks them, and `/sssb:new-slice` adds the screen; the
Items files you removed are at your pinned commit under `apps/starter/` in SSSB's repository):

1. **The table**: a migration `apps/<app>/src/app-config/db/migrations/1001_<name>.ts`, copying Items' row-level
   security policy, listed in that directory's `index.ts`; its row type in `AppTables`,
   `apps/<app>/src/app-config/db/schema.ts`.
2. **Its proofs**: a section in `apps/<app>/src/app-config/db/rls-proofs.ts` showing each of two tenants cannot read or
   write the other's rows. The runner hands you both tenants.
3. **Who may do what**: the subject and its rules in `apps/<app>/src/app-config/abilities.ts`. Everything is denied
   unless a rule allows it.
4. **Its queries**: `apps/<app>/src/domain/db/<name>.ts`, inside `db.withTenant()`. A list that can grow pages with
   `@sssb/kit/db/keyset`.
5. **Its route**: `apps/<app>/src/app/api/<name>/route.ts`. Every handler that changes data calls `authorize(...)`.
6. **Its screen**: a card in `apps/<app>/src/components/`, added to the dashboard through
   `apps/<app>/src/app/[locale]/(protected)/dashboard/dashboard-glue.tsx` and
   `apps/<app>/src/components/dashboard-screen.tsx`.
7. **Its words**: a namespace in `apps/<app>/messages/en.json` and `apps/<app>/messages/es.json`, named in
   `APP_NAMESPACES` (`apps/<app>/src/app-config/messages.ts`). No UI string is written in code.
8. **The static demo**: its rows and card in `apps/<app>/src/demo-static/app.tsx`.
9. **Its tests**: unit tests beside the code, and an e2e spec in `apps/<app>/tests/e2e/`.

Then `pnpm verify` from the workspace root, which runs the contract tests on real Postgres too. The reference, "Building
your product", has the whole seam: jobs, notifications, webhooks, presets and the rest.

## 5. Deploy and cut over

`apps/<app>/infra/app.ts` is a CDK app holding `SssbApp` (`@sssb/cdk`): the server on Lambda behind CloudFront, Aurora
Postgres, the migrator, alarms and a budget. `pnpm synth` checks it offline. Before a first deploy:

- **Fill in `apps/<app>/config/params.ts`.** Each `PLACEHOLDER_` there names the cutover row that fills it.
- **Choose your optional ports** in its `ports`: `llm`, `email`, `inboundEmail` and `jobs`. `none` leaves a port out, so
  real mode needs none of its settings. Never fill an unused port's settings with placeholders.
- **Turn on the scheduled tick.** Recurring work (digests, reminders) and webhook retries only run when something calls
  your app's cron route. Pass `scheduledTick: { webhookSecret }` to `SssbApp`, with the secret your server's
  `WEBHOOK_SECRET` holds, and it is called every five minutes. In development, `pnpm tick` calls it once.
- **Work through `docs/cutover-checklist.md`.** Each row is something that needs a real account, and the proof that
  closes it. `pnpm sssb:doctor` reports a framework row the file stops mentioning.

`apps/<app>/infra/README.md` is the deployment's own guide (region, network shapes, what synth checks). The reference,
"Cutover", has the rest.

## Upgrading by release

SSSB's packages are released together, at one version. A release's notes (under `docs/releases/` in SSSB's repository)
open with "Upgrading to this release", which gives each step below as a command, with that release's version:

1. **Read the notes of every release after yours.** Each entry says what changed, whether you must act, and what to do.
2. **Move every `@sssb/*` package to the new version together**, then `pnpm install`. `sssb doctor` fails on packages
   out of step.
3. **`pnpm exec sssb guide`** refreshes `.claude/sssb-guide.md`, the rules your agents follow, so their change reaches
   your diff.
4. **`pnpm exec sssb pin`** raises your CI workflow's pin and your plugin's to the release's commit.
5. **Apply each entry's "To adopt"**, and delete what its "Now deletable" names.
6. **`pnpm exec sssb doctor`, then `pnpm verify`**, then push.

The reference, "Upgrading, step by step", says why each step is there. A release that turns your app red with no entry
saying why is a bug in its notes: report it in SSSB's repository.
