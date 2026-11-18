---
'@sssb/kit': minor
---

### Since keel 24b0589: operator actions

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
