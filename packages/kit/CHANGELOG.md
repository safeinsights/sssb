# @sssb/kit

## 0.2.0-rc.2

### Minor Changes

- b4770eb: ### An app names the cluster-wide roles its migrations create: `appRoles`

    **Kind.** seam

    **Action.** required

    **What changed.** An app whose migrations create a role of their own (beside the framework's `app_user`) now names it
    in an optional `appRoles` export of its `@sssb/app-config/db/migrations` module. The contract suite's owner pass grants a
    later owner ADMIN on exactly those roles, as it does on `app_user`, so a migration that alters such a role passes on
    every pass, not only the first. It grants on an ordinary role only: it refuses, before granting anything, a named role
    that can log in, has CREATEDB, CREATEROLE, SUPERUSER, BYPASSRLS or REPLICATION, holds a privilege on a server parameter
    (`pg_parameter_acl`), owns a database or tablespace, or is a member, at any depth, of any role but `app_user` and the
    app's other named roles (ADMIN lets the owner grant itself SET on the role and act as it and as all of those), and it
    fails when the owner's own migrations leave a named role more than ordinary. It holds `app_user`, on which every later
    owner gets ADMIN too, to the same attributes, privileges and ownerships, before granting and after the migrations:
    `app_user` may be a member of the app's named roles and of other roles ordinary in shape (another app's, on a shared
    server), never of a `pg_*` or `rds_*` role or one with any of those attributes, privileges or ownerships. A new conformance check, `app-roles`, fails a role the
    migrations create that `appRoles` does not name, a name no migration creates, and a named role or `app_user` the
    migrations leave more than ordinary, on pglite in the unit run. The owner pass's teardown now also revokes what
    its owner granted (`DROP OWNED BY`), so a migration that grants a role TO `app_user` no longer leaves the owner behind,
    and an owner it cannot drop fails the pass instead of staying on the server. An app that creates no role changes
    nothing.

    **To adopt.** If your migrations create a role, export its name beside `appMigrations`, from the module
    `@sssb/app-config/db/migrations` resolves to (`src/app-config/db/migrations.ts`, or `migrations/index.ts`):

    ```ts
    export const appRoles = ['app_maintainer'] as const
    ```

    Create the role only where it does not exist yet, as an ordinary role, and keep it one in every later migration:
    NOLOGIN, no other attribute, no privilege on a server parameter, no database or tablespace of its own, and no membership
    but `app_user` and your other named roles (granting it TO `app_user` is fine):

    ```sql
    DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_maintainer') THEN
            CREATE ROLE app_maintainer NOLOGIN;
        END IF;
    END $$
    ```

    Leave `app_user` ordinary as well: never change its attributes, give it no parameter privilege, database or tablespace, and grant
    it only your named roles.

    Then make a migration that only warned when it lacked ADMIN on its role fail again: the owner pass now gives a later
    owner that ADMIN, so a failure there is real.

    **Now deletable.** A migration that catches `permission denied` on its own role and warns instead of failing, to get
    past the contract suite's second owner pass.

- 3c9d89a: ### Correction: keep the `.gitleaks.toml` entry for keel's `webhook.test.ts`

    **Kind.** scaffold

    **Action.** required

    **What changed.** v0.2.0-rc.0's notes ("Since keel 24b0589: scaffold changes to apply by hand", under `.gitleaks.toml`)
    said to remove the allowlist entry for `packages/keel/src/service-auth/webhook\.test\.ts` along with the directory.
    That was wrong for a workspace that was forked from keel: CI's gitleaks scans the whole history, not the tree
    (`gitleaks git` over a checkout with `fetch-depth: 0`), and the commits that hold that file still carry its
    placeholder secret, so a scan without the entry reports it. Deleting the directory takes the file out of the tree,
    not out of history. A workspace `pnpm create @sssb` generated has no keel history and no such entry.

    **To adopt.** Keep the entry, scoped as it was (`condition = "AND"`, the path and the one string), and say in its
    comment that it covers history only, so nobody removes it later because the file is gone. If you removed it, restore
    it:

    ```toml
    # History only: packages/keel is gone from the tree, but its webhook.test.ts and the placeholder secret below are
    # still in this repository's history, which gitleaks scans.
    [[allowlists]]
    description = "keel's webhook.test.ts WEBHOOK_SECRET fixture, in history only"
    condition = "AND"
    paths = ['''packages/keel/src/service-auth/webhook\.test\.ts''']
    regexes = ['''env-secret-abcdef0123456789''']
    regexTarget = "line"
    ```

    The rest of that item stands: give any entry of the app's own that pairs `paths` with `regexes` `condition = "AND"`.

### Patch Changes

- 3c9d89a: ### The real S3 storage adapter is published: `@sssb/kit/adapters/real/s3-storage`

    **Kind.** seam

    **Action.** optional

    **What changed.** The storage adapter SSSB's real-mode registry builds is now published as
    `createS3Storage(options)` from `@sssb/kit/adapters/real/s3-storage`, so an app that needs storage outside SSSB's
    registry (a simulated app run against a real bucket or an S3-compatible endpoint, say) uses the same adapter rather
    than a copy. The options are `bucket` (required), and `region`, `endpoint`, `credentials` (values or a provider) and
    `forcePathStyle`, each passed to the S3 client as the AWS SDK names it; or `client`, an `S3Client` you built, used as it
    is. A `client` together with any of the four client options is refused, since they would be ignored. Left out, region
    and credentials come from the AWS SDK's own lookup. The storage port (`@sssb/kit/ports/storage`) is unchanged.

    **To adopt.** Where the app builds the storage port itself, import the factory from a module in its own
    `src/adapters/real/` (elsewhere on the app's request path SSSB's real adapters are loaded only with `import()`):

    ```ts
    import { createS3Storage } from '@sssb/kit/adapters/real/s3-storage'

    // adapters/real/ is where an app reads process.env
    const storage = createS3Storage({
        bucket: process.env.STORAGE_BUCKET as string,
        region: 'us-east-1',
        endpoint: 'http://127.0.0.1:9000', // an S3-compatible endpoint; leave out for AWS
        forcePathStyle: true, // as most S3-compatible endpoints need
    })
    ```

    `credentials` takes what the AWS SDK's `S3Client` takes, static keys or a provider such as `fromIni()` from
    `@aws-sdk/credential-providers` (a dependency of the app's own).

    **Now deletable.** A copy of SSSB's S3 storage adapter (a `StoragePort` built on `@aws-sdk/client-s3`, its presigned
    download URLs forced to `attachment`) kept in the app's `adapters/real/` because the kit did not publish one.

## 0.2.0-rc.1

No changes in this release.

## 0.2.0-rc.0

### Minor Changes

- 362056f: ### The app guide gains the cutover rule and the dev loop

    **Kind.** seam

    **Action.** required

    **What changed.** SSSB's app guide (`@sssb/kit/guide.md`) now also says what SSSB's own agent guide said only to its
    maintainers and an app author needs: anything needing real credentials is a row in the workspace's cutover checklist,
    never a blocker; scheduled work runs in dev only when something ticks it (`pnpm tick`, `DEV_TICK_SECONDS`), and the
    cron route stays behind `withWebhookSecret`; a linked worktree derives the app's ports per checkout
    (`pnpm exec sssb port`); and the workflow (`pnpm verify` before finishing, `pnpm lint:fix`, conventional commits).
    `sssb doctor` fails until the workspace's copy is refreshed.

    **To adopt.** Run `pnpm exec sssb guide` from your app and commit the diff of `.claude/sssb-guide.md`.

    **Now deletable.** Those rules copied by hand from SSSB's `CLAUDE.md` into your own.

- e574680: ### The app guide ships in `@sssb/kit`

    **Kind.** seam

    **Action.** required

    **What changed.** `@sssb/kit` ships the app guide, the rules an agent follows in your app (the seam, vendor SDKs only
    in adapters, `db.withTenant()`, `authorize(...)`, i18n, router-agnostic screens, hermetic dev, migrations, the
    conformance and contract tests), at the published subpath `@sssb/kit/guide.md`. `sssb guide` copies it into your
    repository under a hash stamp, and `sssb doctor` now fails while that copy is missing or stale. The doc-paths gate
    gained `sssb.docPaths.relativeTo`, which reads a doc's citations against a directory instead of the workspace root.

    **To adopt.** From any app, run `pnpm exec sssb guide`; it writes `.claude/sssb-guide.md` at the workspace root.
    Commit it, and import it from your own `CLAUDE.md` with a line holding `@.claude/sssb-guide.md`. The guide cites paths
    relative to an app (`src/app-config/`, `config/params.ts`), so if your `sssb.docPaths.include` reaches `.claude`, map
    the copy to your app in the root `package.json`: `"relativeTo": { ".claude/sssb-guide.md": "apps/<app>" }` inside
    `sssb.docPaths`. After each upgrade, run `pnpm exec sssb guide` again and review the diff before you commit it.

    **Now deletable.** Rules copied by hand from SSSB's `CLAUDE.md` into your own: the seam, vendor and `process.env`
    fences, tenancy, authorization, i18n, migration numbering and the test conventions the guide now states.

- 835e887: ### The starter runs the conformance suite and doctor

    **Kind.** scaffold

    **Action.** required

    **What changed.** The starter gained `src/sssb.conformance.test.ts`, its `tests/contract/rls-contract.test.ts` calls
    `contractSuite` from `@sssb/kit/testing/contract`, and its `package.json` gained the `sssb:doctor` (`sssb doctor`) and
    `check:e2e` (`sssb check-e2e`) scripts and an `embedded-postgres` devDependency.

    **To adopt.** Copy the starter's `src/sssb.conformance.test.ts` into each app, replace the body of each app's
    `tests/contract/rls-contract.test.ts` with the starter's, and add the two scripts and the devDependency to each app's
    `package.json`. Run `pnpm exec sssb doctor` once from any app: it checks every app of the workspace.

- 835e887: ### The conformance suite, `sssb doctor` and `sssb check-e2e`

    **Kind.** seam

    **Action.** required

    **What changed.** The framework's checks that must hold for every app now ship as a suite the app calls from its own
    tree: `@sssb/kit/testing` (the authorization scan of the app's routes, i18n partition and parity, the pglite RLS
    proofs, migration order, demo presets, the seam map) and `@sssb/kit/testing/contract` (the same proofs on real
    Postgres as a non-superuser owner and as a superuser, and over the RDS Data API through its emulator). The kit no
    longer ships its seam-conformance test files. `sssb doctor`, one run for every app of the workspace, fails unless
    each singleton peer has one copy, every importer of `@sssb/kit` links its own seam, the `@sssb/*` packages share one
    version, the Vitest config a bare `vitest` would load for each app runs every unit check, and some config runs every
    contract check. It reports, without failing, any other Vitest config that runs an app's tests without the checks, a
    bare `vitest` from an app's directory that would not run its suite when the root's run is the main one, the narrowing
    flags the package.json scripts pass to vitest, and which script runs each contract config, since it cannot
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
      `reason` and a `mustMatch` gate; one that matches no mutating route in the app, overlaps a framework entry, or is a prefix
      nested in another of the app's prefixes, fails.
    - In Playwright specs, import webhook-signature helpers from `@sssb/kit/testing/e2e`, not `@sssb/kit/core/…`, and
      read app constants from modules that import nothing from SSSB but types.
    - Run `sssb doctor` (once, from the workspace root) and `sssb check-e2e` (in each app) in verify and in CI, and read
      doctor's reports: if CI runs a Vitest config other than the one doctor holds to the checks, they do not run there.

    **Now deletable.** A Vitest `include` that reaches the framework's test files under `node_modules`, with the default
    `exclude` overridden to let them run; a copied real-Postgres contract harness (a `defineContractSuite` and its server
    helper); and a hand-run `readlink -f` comparison of the app's and the framework's React, Next or Mantine copies.

- 2781d4a: ### Since keel 24b0589: framework migrations

    **Kind.** migration

    **Action.** required

    **What changed.** Three framework migrations, `0014` to `0016`, arrived after keel's `24b0589` and run on the
    migrator's next run. Before them comes a fix to the migrator itself: one bundled the way keel's `infra/stack.ts` did
    at `24b0589` carries the wrong app's migrations.

    **To adopt.** Deploy a migrator bundled from the app (first item) before it runs against any database, make sure the
    database is Postgres 16 or later, then run it once.

    #### The migrator runs the app's migrations only when bundled from the app (jpslav/keel#54)

    At `24b0589`, `infra/stack.ts` bundled the migrator Lambda with the repository's root `tsconfig.json`, whose
    `@app-config/*` path points at keel's test fixture, so the bundle carried the fixture's `1001_dockets`,
    `1002_dockets_due_on` and `1003_dockets_last_touched_at` and none of the app's migrations. `SssbApp` bundles it from
    the app's own `@sssb/kit` with the app's seam and fails `cdk synth` otherwise (see "Each app's deployment lives in the
    app, on the `SssbApp` construct"). A stack of the app's own passes the app's `tsconfig.json` as the migrator's
    `bundling.tsconfig` and checks the synthesized bundle with `migratorBundleProblems` from
    `@sssb/tools/assembly-checks`. If an old migrator ever ran, the database's `kysely_migration` table names
    `1001_dockets`, and it holds the fixture's tables rather than the app's.

    #### `0014_audit_credential` (jpslav/keel#34)

    Adds the nullable `credential_kind` and `credential_id` columns to `audit_events`: which credential an audited actor
    used. Earlier rows read NULL. Nothing to do.

    #### `0015_app_user_grant`, which needs Postgres 16 (jpslav/keel#53)

    Without it, on Aurora, whose master user is not a superuser, every `withTenant` failed with
    `permission denied to set role "app_user"`: the migrating role created `app_user` but could not switch to it.
    `0015` grants the migrating role `SET` on `app_user`, with `INHERIT FALSE`, and is a no-op for a superuser. It uses
    Postgres 16's `GRANT … WITH SET`, so SSSB now needs Postgres 16 or later. When the migrating role holds no ADMIN on
    `app_user` (a second owner on a cluster where another role created it), the run stops at `0015` and rolls back
    whole, and the error, which still begins `keel:`, gives the `GRANT` to run as a role that does hold it; the next run
    then migrates. A separate application role, and a restored dump, need the steps under "Operator actions".

    #### `0016_audit_detail` (jpslav/keel#58)

    Adds a nullable `detail jsonb` to `audit_events`, one `ALTER TABLE`; the table stays append-only for `app_user`.
    Nothing to do. An app's own screen that shows audit rows renders `detail` as text, never as HTML or Markdown.

    #### On the opt-in Data API transport (jpslav/keel#46)

    An app on `params.database.transport: 'data-api'` migrates every pending migration in one Data API transaction
    behind `pg_advisory_xact_lock`. The transaction dies after an hour or three idle minutes, and any statement still running at 45 seconds (waiting for
    that lock included) is cancelled (AWS's Data API limits, `packages/kit/src/adapters/real/migrate-handler.ts`); a
    migration that cannot fit runs on `pg`, from inside the VPC.

    **Now deletable.** A migrator entry in the app's own infra that names `packages/keel/src/adapters/real/migrate-handler.ts`
    with the root `tsconfig.json`.

- 2781d4a: ### Since keel 24b0589: operator actions

    **Kind.** operator

    **Action.** required

    **What changed.** What a deployer does for the changes since keel's `24b0589`: a Postgres floor, a grant a separate
    application role needs, a database transport chosen per app, the scheduled tick, and new cutover rows.

    **To adopt.**

    #### Postgres 16 or later (jpslav/keel#53)

    Framework migration `0015` needs it ("Framework migrations"). Aurora PostgreSQL 16.x meets it.

    #### A separate application role is granted the switch to `app_user` (jpslav/keel#53)

    Where the app connects as a role other than the migrating one (cutover row `db-role-not-superuser`), run this as the
    migrating role, or any role holding ADMIN on `app_user`:

    ```sql
    GRANT app_user TO <app role> WITH SET TRUE, INHERIT TRUE;
    ```

    After restoring a `pg_dump` into another cluster (roles are not in a dump, and the ledger says `0001` and `0015`
    already ran), as the migrating role: `CREATE ROLE app_user NOLOGIN;` before the restore; after it,
    `GRANT app_user TO CURRENT_USER WITH SET TRUE, INHERIT FALSE;` and the app role's grant above; then check
    `SET LOCAL ROLE app_user` as each role.

    #### The database transport is chosen per app, before the first deploy (jpslav/keel#46, #49)

    `apps/<app>/config/params.ts` names it as `database: { transport: 'pg' }` (the default, a Lambda inside the
    database's VPC) or `'data-api'` (opt-in: the RDS Data API from Lambdas outside any VPC, with no NAT). `SssbApp`
    refuses params without it. Both Lambdas now get `DATABASE_TRANSPORT`; on `data-api`, `DATABASE_CLUSTER_ARN`,
    `DATABASE_SECRET_ARN` and `DATABASE_NAME` replace `DATABASE_URL`, and IAM on that one cluster and its secret is the
    only path to the database. Switching an existing stack does not work (the new subnets overlap the old and the
    deploy rolls back): changing shape later means a new stack and a restore from a snapshot.

    #### The scheduled tick (jpslav/keel#55)

    Point a scheduler at the app's `/api/webhooks/cron` (cutover row `scheduled-tick`), POSTing on a fixed cadence with
    `Authorization: Bearer $WEBHOOK_SECRET`. An app with no such route takes the starter's ("Scaffold changes to apply
    by hand"); without one, nothing runs SSSB's schedules or webhook deliveries in a deployment.

    #### New cutover rows (jpslav/keel#40, #46, #49, #52)

    Add to the app's cutover checklist the rows it needs, as `@sssb/kit/cutover/rows.json` lists them: `data-api` and
    `data-api-access` for an app on the Data API, and `storage-copy` and `storage-head` for an app that calls the
    storage port's `copy` or `head`. Each is proven against the real service.

    #### Logs and alerts (jpslav/keel#61; safeinsights/sssb#8)
    - A pooled `pg` connection the server ends (a failover, an idle timeout) is now logged as
      `SSSB db: a pooled database connection ended (<code>: <message>)` instead of crashing the Lambda. A metric filter
      on that text counts them.
    - Sentry 11 changes its own span names and attributes (Sentry's v11 migration guide; safeinsights/sssb#8). Check any
      Sentry dashboard or alert that filters on v10's.

- 2781d4a: ### Since keel 24b0589: scaffold changes to apply by hand

    **Kind.** scaffold

    **Action.** required

    **What changed.** What changed since keel's `24b0589` in files an adopter keeps and edits: the fork's copy of the
    framework gives way to the packages, the starter gained a cron route, and some write-once files (the gitleaks rules,
    the `LICENSE` line) moved on. `@sssb/tools`, `@sssb/eslint-plugin`, the conformance suite and the per-app infra each
    have their own entry in these notes; this one is the rest.

    **To adopt.**

    #### Replace the fork's `packages/keel` with the packages (safeinsights/sssb#6, #16)
    - Delete `packages/keel`, and every path that reaches it: tsconfig `paths` and `include` entries, Vite and Vitest
      aliases for `keel` and `@app-config`, `next.config.ts`'s next-intl request path and `transpilePackages: ['keel']`
      (the `withSssb` preset sets both), and the entries for it in `panda.config.ts`, `.ladle`, `knip.json`,
      `.jscpd.json` and CODEOWNERS.
    - Drop `"keel": "workspace:*"` from every `package.json`, and install the packages as these notes' install lines say.
    - In `pnpm-workspace.yaml`, set `dedupePeerDependents: false`, so each importer of `@sssb/kit` gets an instance that
      links its own seam, then install once from scratch (no lockfile, no `node_modules`): pnpm re-resolves under that
      setting only from scratch. `sssb doctor` advises when it is missing.

    #### The starter's scheduled-tick route (jpslav/keel#55, safeinsights/sssb#17)

    An app with no `src/app/api/webhooks/cron/route.ts` copies the starter's (`apps/starter/src/app/api/webhooks/cron/`,
    with its `route.test.ts`): `export const POST = withWebhookSecret(async () => Response.json({ ok: true, ...(await runScheduledTick()) }))`.
    A cron route of the app's own stays, wrapped by `withWebhookSecret` as the authorization scan requires. In
    development `sssb tick <slot>` POSTs it with the per-checkout dev secret, and `DEV_TICK_SECONDS=<seconds> pnpm dev`
    ticks it on a timer (opt-in); the app's `playwright.config.ts` starts its web server with
    `env: { DEV_TICK_SECONDS: '' }` so a value in the shell never reaches an e2e run.

    #### `.gitleaks.toml` (jpslav/keel#60)

    Remove the allowlist entry for `packages/keel/src/service-auth/webhook\.test\.ts` with the directory. Give any entry
    of the app's own that pairs `paths` with `regexes` `condition = "AND"`: without it, gitleaks combines them with OR
    and exempts every finding in those paths.

    #### The `LICENSE` line (safeinsights/sssb#14)

    SSSB's copyright is now Rice University's, and the licence stays MIT. Where the app's repository keeps SSSB's notice
    for the files that came from it, the line reads `Copyright (c) 2026 Rice University`.

    #### Smaller starter changes, if the app kept a copy
    - The sign-in picker (`src/app/[locale]/signin/page.tsx`) leaves out a person with no membership instead of reading
      the role of `memberships[0]` (safeinsights/sssb#7).
    - An app that kept the showcase's Panda pipeline moves to `@pandacss/dev` 2 and runs `panda codegen --clean` once:
      Panda 2 writes `.js` instead of `.mjs` and leaves Panda 1's files behind. Panda 2 no longer implies its base
      presets, so an app that uses Panda's tokens, patterns or conditions lists `@pandacss/preset-base` and
      `@pandacss/preset-panda` in `panda.config.ts`'s `presets`
      (safeinsights/sssb#9).
    - A Simulator control for the dev ticker is the showcase's `src/app/api/simulator/ticker/` route, which answers 404
      unless `isSimulatedDevServer`, and the Jobs tab's `ticker` prop (safeinsights/sssb#19).

    #### SSSB's release machinery is SSSB's

    `.changeset/`, `.github/workflows/release.yml`, `scripts/release*.mjs` and CI's `changeset-required` and
    `release-plan` jobs release SSSB (safeinsights/sssb#10, #21); an app does not copy them. Each later release's notes are
    assembled from its changesets, and an entry marked `required` breaks an app that does nothing.

    **Now deletable.** `packages/keel`, keel's `spikes/kysely-pglite` (its `spikes/*` workspace entry and CI step), keel's
    own gates in `tests/` (`tests/lint`, `tests/tooling`, `tests/docs`, `tests/support`) and `tests/vitest.setup.ts`,
    which the conformance suite and the Vitest preset replace.

- 2781d4a: ### Since keel 24b0589: seam changes

    **Kind.** seam

    **Action.** required

    **What changed.** Everything since keel's `24b0589` that changes what an app must say or satisfy to build, from
    before changesets existed: the rename to SSSB, new peer floors, four new exports in the abilities seam, an
    authorization scan that reads each handler, lint fences that reach further, and two ports that grew. The changes
    that came with changesets of their own (`@sssb/tools`, `@sssb/eslint-plugin`, the conformance suite,
    `sssb check-fences`, an app's vendors in `package.json`) are their own entries in these notes.

    **To adopt.**

    #### The framework is `@sssb/kit`, and the seam is `@sssb/app-config` (safeinsights/sssb#6)
    - Rewrite every `keel/…` import to `@sssb/kit/…` and every `@app-config/…` to `@sssb/app-config/…`, in source,
      tests, `vi.mock` and `import()` specifiers. The seam's directory stays `apps/<app>/src/app-config`.
    - Make the seam a workspace package (`seam-workspace-package.md` has why: a `link:` is unlinked by `pnpm add`): list
      `apps/*/src/app-config` in `pnpm-workspace.yaml`'s `packages`, give `src/app-config/package.json`
      `{ "name": "<name>-app-config", "private": true, "exports": { "./db/migrations": "./db/migrations/index.ts", "./*": "./*.ts" } }`,
      plus the app's own `"type"` if its `package.json` sets one, and declare
      `"@sssb/app-config": "workspace:<name>-app-config@*"` in the app's `dependencies` (`<name>` is the app's package
      name). A seam module that is a directory or a `.tsx` file
      needs an entry of its own; the conformance suite's `seam-map` check names one that is missing.
    - Lint rule ids `keel/<rule>` are `sssb/<rule>`: rename them in `eslint-disable` comments and in the keys of
      `lint-exceptions.mjs` (a `keel/no-raw-db-handle` key stops the lint config loading, naming the file).
    - The guided tour's cursor ids are `sssb-tour-cursor` and `sssb-tour-cursor-ring`, for CSS or a test that targets
      them.

    #### Peer floors (safeinsights/sssb#8, #11, #16; jpslav/keel#36, #37, #41)
    - The app provides `@sssb/kit`'s peers: `react` `~19.3.1` (keep the app's own `react-dom` at the same version), `@types/react`
      `~19.3.0`, `next` `^16.4.6`, `next-intl` `^4.14.9`, `@mantine/core` `^9.7.3`, `kysely` `^0.29.7` (no longer a
      dependency of the kit), `typescript` `~6.0.3` and `@types/node` `^26.6.5`. `vitest` `^4.1.12` and
      `embedded-postgres` are optional peers, for the conformance and contract suites. `sssb doctor` fails while any
      singleton has two copies.
    - React 19.3 adds about 29 KB to a static demo. If `sssb check-demo-size` now fails, re-measure and raise the
      app's own number.
    - The kit depends on `@sentry/nextjs` 11. An app that wraps its Next config imports `withSentryConfig` from
      `@sentry/nextjs/config` (11 no longer exports it from the package root), and moves its own `@sentry/nextjs` to 11.
      The kit's Sentry init holds data collection at or below v10's (`SENTRY_V10_BASELINE`).

    #### The abilities seam has four new exports (jpslav/keel#34)

    `src/app-config/abilities.ts` must export these, with `NonSessionAdministration` from `@sssb/kit/core/abilities`:

    ```ts
    export type AppPersonCredentialKind = never
    export type AppMachineCredentialKind = never
    export function appMachineAbilityRules(): boolean {
        return false
    }
    export const nonSessionAdministration: NonSessionAdministration = {}
    ```

    The same change also asks:

    - An `AbilityActor` literal whose `manageAll` may be true states its session,
      `credential: { kind: 'session', id: null }`, or it no longer compiles: only a stated session wields `manageAll`.
    - Non-read actions on Membership, Org, WebhookEndpoint and AgreementAcceptance are refused to a person who states
      no session credential (a token, an email), unless `nonSessionAdministration` widens that subject. It can never
      widen it to `inbound-email`.
    - In real mode, a member whose org role is `restricted` is now restricted in their session too.
    - `OrgIdentity` is branded: only `orgIdentityForSlug` (`@sssb/kit/db/org-lookup`) makes one, so a hand-paired
      `{ id, slug }` no longer compiles. `InboundContext` gains `org`, and `InboundHandlerResult` an optional
      `credential` (`auditActorOf(actor)` from `@sssb/kit/db/audit` gives it).
    - An app with an auth adapter of its own implements `AuthPort.getMember`; a test that builds a `ServiceIdentity` by
      hand adds `keyId`.

    #### The authorization scan judges each handler (jpslav/keel#34, #59)

    The conformance suite's `authz-mutations` check reads every route with the TypeScript compiler:

    - Each exported `POST`, `PUT`, `PATCH` and `DELETE` must reach `authorize(...)` on its own path. A call in a
      string, a comment, another verb, a dead branch or a function never called no longer counts.
    - An `api/webhooks/` route is exempt only when the verb's export is itself a call to an imported
      `withWebhookSecret` (`@sssb/kit/service-auth/webhook`) or `withMailgunSignature`:
      `export const POST = withWebhookSecret(async () => …)`.
    - `api/service/` routes are no longer exempt. The handler is a call to the app's `withServiceCaller` (as in the
      showcase's `src/app/api/service/respond.ts`) and calls `authorize(...)` with the machine actor it is given.

    #### Lint fences reach further (jpslav/keel#38, #47, #51)

    Every fence covers every extension ESLint lints (`.js`, `.jsx`, `.mjs`, `.cjs`, `.mts` and `.cts` too).
    `sssb/no-raw-db-handle` covers every module under the app's `src/` (tests apart, except a route's or a screen's)
    and catches `getDb` named as a string (`Reflect.get(db, 'getDb')`). The vendor ban also holds in a type-position
    `import('…')`. Run `pnpm lint`. A module that truly needs the raw client is listed in `apps/<app>/lint-exceptions.mjs`
    with a reason, `{ 'sssb/no-raw-db-handle': [{ file: 'src/…', reason: '…' }] }`, never by editing the fences.

    #### Two ports grew (jpslav/keel#40, #52, #55)
    - `StoragePort` gains `copy(from, to, options?)` and `head(key)`; an app's own storage adapter or test double
      implements both. `NotFoundError` and the new `PreconditionFailedError` are in `@sssb/kit/ports/errors`.
    - `DbPort` gains an optional `now()`, the simulated world's clock, which audit rows take their time from. A wrapper
      around the framework's `DbPort` passes it through (a spread does).

    #### Four framework controls have new accessible names (safeinsights/sssb#18)

    The team switcher, the account menu, the Simulator pill and its Hide button are named from their visible text:
    "{team}, switch team", "{name}, account menu" (the user's name, or their email when it is blank), "Simulator, open the panel" (or "Simulator, 3 unread emails,
    open the panel") and "Hide the Simulator panel". An e2e spec that finds them by their old names needs the new ones.

    #### New, and nothing to change

    `runScheduledTick` (`@sssb/kit/server-lib/scheduled-tick`) and `withWebhookSecret`; `machineActor` and
    `abilityActorFromCredential` (`@sssb/kit/authz/authorize`) for routes called by a token or a machine;
    `recordAuditEvent`'s optional `detail`, which takes codes and counts only and throws, after the mutation has
    committed, on anything shaped like a secret or an email address; `isSimulatedDevServer` (`@sssb/kit/adapters/index`);
    `JobsApp`'s optional `ticker`; and `appDb` beside `db` in an `RlsProofSuite`'s context, which an app's
    `src/app-config/db/rls-proofs.ts` should switch roles with, so the contract suite's owner pass proves its proofs as
    a non-superuser.

    **Now deletable.** Path mappings and aliases for `keel` and `@app-config` in tsconfig, Vite and Vitest configs; a
    hand-paired `{ id, slug }` org literal; and a `getDb` exception written into a root `eslint.config.mjs`.

- daa8637: ### The seam is a workspace package, so `pnpm add` keeps it linked

    **Kind.** seam

    **Action.** required

    **What changed.** An app's seam declared as `"@sssb/app-config": "link:./src/app-config"` is unlinked from the app's
    `@sssb/kit` by the next partial install for the app, `pnpm add <pkg>`, `pnpm remove <pkg>` or `pnpm update <pkg>`,
    whether run from the root with `--filter` or in the app's directory: `sssb doctor` then fails ("runs on a seam not its
    own") and typecheck fails inside the kit, and `pnpm install` does not bring it back. The seam is now a workspace
    package with a name of its own, which the app takes under the name the framework imports, and pnpm keeps that linked.
    `sssb doctor` fails an app that still declares its seam as a `link:`, even while it is linked, and says what to
    change; it also fails an app whose declared seam is another app's, and one whose `workspace:` seam names no workspace
    package, or more than one (an adopter who skips step 1 sees this).
    The conformance suite's `seam-map` check holds the seam's `package.json` to the name the app declares it by. A
    workspace `pnpm create @sssb` writes has the new form, and the plugin's commands say `pnpm --filter <app> add <pkg>`
    again.

    **To adopt.** For each app (`apps/<app>`, whose `package.json` name is `<name>`):

    1. In `pnpm-workspace.yaml`, add the seams to `packages`: `- apps/*/src/app-config`, or each app's
       `apps/<app>/src/app-config`.
    2. In `apps/<app>/src/app-config/package.json`, change `"name": "@sssb/app-config"` to `"name": "<name>-app-config"`
       (any name no other package of the workspace has; leave `exports` and `type` as they are).
    3. In `apps/<app>/package.json`, change `"@sssb/app-config": "link:./src/app-config"` to
       `"@sssb/app-config": "workspace:<name>-app-config@*"`.
    4. Run `pnpm install` and commit `pnpm-lock.yaml`, then `pnpm sssb:doctor` (or
       `pnpm exec sssb doctor --app apps/<app>`). This also repairs a seam a
       `pnpm add` already unlinked; no clean install is needed.
    5. If your `knip.json` lists `src/app-config/**` among an app's entries, knip now counts those files as the seam's own
       workspace: move them to `"apps/<app>/src/app-config": { "entry": ["**/*.ts"] }`.

    **Now deletable.** Any rule or note telling authors to edit `package.json` by hand instead of running `pnpm add`, to
    restore `pnpm-lock.yaml` after one, or to delete every `node_modules` and the lockfile to relink the seam.

### Patch Changes

- 8e5fd17: ### A dashed slug names a database Aurora accepts

    **Kind.** none

    **Action.** none

    **What changed.** `SssbApp` names the app's database from its slug with each dash as an underscore (`acme-corp`
    becomes `acme_corp`): the cluster's default database, the server's `DATABASE_NAME` or `DATABASE_URL`, and the
    migrator's `DATABASE_NAME`, which the framework's migrate handler now prefers to the secret's `dbname` on `pg`. Aurora
    PostgreSQL's database names allow no dash, so an app with a dashed slug synthesized and then failed at deploy. A slug
    with no dash names the same database as before, so no existing deployment's database changes. A slug whose name the
    engine reserves (`user`, `select`) or that runs past 63 characters is refused at synth.
    `databaseNameFor(slug)`, exported from `@sssb/cdk`, gives the same name to infra that does not use the construct.

- 846d11d: ### Linear-time trims, and complete escaping

    **Kind.** none

    **Action.** none

    **What changed.** Trims that used regexes taking time quadratic in a long run of one character now use loops or an
    index, with the same results: the doc-path engine (`@sssb/tools/doc-paths`, `sssb check-doc-paths`) on trailing
    slashes, quotes and `,;)`; `sssb doctor` on trailing slashes in `pnpm-workspace.yaml` globs; `@sssb/create` on a git
    remote's trailing slashes; and `@sssb/eslint-plugin`'s package-edge rule on a specifier's `?query` or `#hash`.
    `contractDatabaseName` (`@sssb/kit/testing`) trims its underscores by a loop too. `sssb doctor` still fills only the
    first `*` of a tsconfig `paths` target, as TypeScript's resolver does, without `String#replace`. The app preset of
    `@sssb/eslint-plugin` also escapes a backslash when it turns a name into a glob; no app can reach that case today (an
    app directory whose name holds a backslash cannot load its `lint-exceptions.mjs`, the only place the name is used).

- 9b1dce7: ### The conformance and contract suites clean up their scratch directories under `isolate: false`

    **Kind.** none

    **Action.** none

    **What changed.** With Vitest's `isolate: false`, a later test file that ran `conformanceSuite` or `contractSuite` could
    leave behind the contract server's scratch directory, made in a `beforeAll`, so `sssb check-tmpdir-leak` failed the
    run. Each suite now registers its file's cleanup itself, after its own teardown, so its directories are removed in
    every file. A demo-presets replay that outlives its test no longer has its directory deleted under it. Nothing changes in the app: both suites are already called at a test file's top level.

- 362056f: ### The plugin enabled at the workflow's commit, and `sssb doctor` reporting both pins

    **Kind.** scaffold

    **Action.** optional

    **What changed.** `@sssb/kit` names the commit it was released from in `dist/release.json`, and `sssb doctor` reports
    (never fails) when the commit your `.github/workflows/*.yml` pins SSSB's reusable workflow at, or the one your
    `.claude/settings.json` pins SSSB's plugin marketplace at, is not that commit, naming both, and when no plugin is
    enabled from that marketplace (naming the ones that are). A workspace
    `pnpm create @sssb` writes now has a `.claude/settings.json` that declares SSSB's marketplace (`sssb`) pinned to the
    workflow's commit and enables its plugin (`sssb@sssb`: the app-author commands as `/sssb:<command>`, and the
    `doc-steward` agent), and a `CLAUDE.md` that imports `.claude/sssb-guide.md`.

    **To adopt.** In an existing workspace, write `.claude/settings.json`:
    `{ "extraKnownMarketplaces": { "sssb": { "source": { "source": "github", "repo": "safeinsights/sssb", "ref": "<the
commit your workflow pins>" } } }, "enabledPlugins": { "sssb@sssb": true } }`. A commit `ref` needs Claude Code 2.1.324
    or later. Each person runs `claude plugin install sssb@sssb --scope project` once per clone, after trusting the folder.
    Keep a line holding `@.claude/sssb-guide.md` in your `CLAUDE.md`. On each upgrade, raise the marketplace's `ref` with
    the workflow's pin.

    **Now deletable.** Copies of SSSB's app-author commands and `doc-steward` agent kept in your own `.claude/commands/`
    and `.claude/agents/`.
