---
'@sssb/kit': minor
---

### Since keel 24b0589: framework migrations

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
