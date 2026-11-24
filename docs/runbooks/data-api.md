# Runbook: the RDS Data API driver, proven live

> **Status: pre-cutover.** The opt-in `data-api` transport is proven against real Postgres through a strict
> emulator in `pnpm test:contract`, never against the Data API itself. This is the procedure that
> closes the `data-api` row of `docs/cutover-checklist.md`. Run it against a staging cluster, never
> production, and record what each step returned in that row.

ADR-0002's addendum of 2026-11-16 explains the transport and separates what is documented from what is
proven. The dialect is `packages/kit/src/adapters/real/rds-data-dialect.ts`. It is selected with
`DATABASE_TRANSPORT=data-api` plus `DATABASE_CLUSTER_ARN`, `DATABASE_SECRET_ARN` and `DATABASE_NAME`
(`packages/kit/src/adapters/real/index.ts`), which the deployment sets from the app's
`params.database.transport`.

## Preconditions

- The cluster has the Data API enabled. Steps 1–4 need a database with the migrations applied, by the
  migrator on either transport. Step 5 needs one no migrator has touched, so that every migration goes
  through the Data API: see there.
- Your shell can call `rds-data:*` on the cluster and `secretsmanager:GetSecretValue` on its secret.
- For steps 1–4, at least one tenant with rows in a tenant-scoped table (`jobs` is in every app).
- `DB` is the app's database: its slug with each dash as an underscore (`acme-corp` is `acme_corp`), the
  `DATABASE_NAME` its server function runs with (`databaseNameFor` in `packages/cdk/src/database-name.js`).

```bash
export CLUSTER=arn:aws:rds:REGION:ACCOUNT:cluster:NAME
export SECRET=arn:aws:secretsmanager:REGION:ACCOUNT:secret:NAME
export DB=your_database
export TENANT=a-tenant-uuid
rds() { aws rds-data "$@" --resource-arn "$CLUSTER" --secret-arn "$SECRET"; }
```

## 1. Tenant context lasts for one transaction, and no longer

This is the question the transport rests on. Run the calls one at a time. The second is the statement
`withTenant` itself sends (`packages/kit/src/db/with-tenant.ts`):

```bash
TX=$(rds begin-transaction --database "$DB" --query transactionId --output text)
rds execute-statement --database "$DB" --transaction-id "$TX" \
  --sql "SELECT set_config('role', 'app_user', true), set_config('app.current_tenant', '$TENANT', true)"
rds execute-statement --database "$DB" --transaction-id "$TX" \
  --sql "SELECT current_user, current_setting('app.current_tenant', true)"
rds execute-statement --database "$DB" --transaction-id "$TX" \
  --sql "SELECT count(*), count(*) FILTER (WHERE tenant_id <> '$TENANT'::uuid) FROM jobs"
rds commit-transaction --transaction-id "$TX"
rds execute-statement --database "$DB" --sql "SELECT current_user, current_setting('app.current_tenant', true)"
```

Pass when:

- the third call returns `app_user` and `$TENANT`, so the role and the tenant reached a later call;
- the fourth returns the tenant's own count and **0** in the second column;
- the last call, after the commit, returns the secret's user (not `app_user`) and NULL or an empty
  string, so nothing outlived the transaction;
- `commit-transaction` answered `"transactionStatus": "Transaction Committed"`, the only answer the dialect
  takes for a commit (`commitOutcome` in `packages/kit/src/adapters/real/rds-data-codec.ts`). Record it
  exactly, and do this before any traffic reaches the transport. The dialect reads the answer after the
  commit has happened, so if AWS words it differently, every commit is saved and then reported to the app
  as a failure. Fix `commitOutcome` first.

Then send a statement on a transaction id that has ended: the one just committed, and a second left idle
past the three-minute limit.

```bash
rds execute-statement --database "$DB" --transaction-id "$TX" \
  --sql "SELECT current_user, current_setting('app.current_tenant', true)"
TX=$(rds begin-transaction --database "$DB" --query transactionId --output text)
rds execute-statement --database "$DB" --transaction-id "$TX" \
  --sql "SELECT set_config('role', 'app_user', true), set_config('app.current_tenant', '$TENANT', true)"
sleep 200
rds execute-statement --database "$DB" --transaction-id "$TX" \
  --sql "SELECT current_user, current_setting('app.current_tenant', true)"
```

Pass when the first and the last call both FAIL, with no row returned. If AWS ran either outside a
transaction instead, the tail of a `withTenant` that outlived the idle limit would run outside the
transaction it belonged to, as the secret's user, with no tenant set. Every RLS table in SSSB and its
apps also forces RLS (ADR-0004), so a non-superuser owner is still bound by it: its reads return nothing
and its inserts are refused. Only a superuser or a role with `BYPASSRLS` escapes, and the
`db-role-not-superuser` cutover row forbids those. Either way the statement has left its transaction:
stop, and treat the transport as unsafe. Record each exception's name and message.

## 2. Postgres's parameter inference works through the Data API

The dialect PREPAREs each new statement shape and reads `pg_prepared_statements`:

```bash
TX=$(rds begin-transaction --database "$DB" --query transactionId --output text)
rds execute-statement --database "$DB" --transaction-id "$TX" \
  --sql 'PREPARE sssb_probe AS SELECT id FROM tenants WHERE id = $1 AND slug = $2'
rds execute-statement --database "$DB" --transaction-id "$TX" \
  --sql "SELECT parameter_types::text[] FROM pg_prepared_statements WHERE name = 'sssb_probe'"
rds rollback-transaction --transaction-id "$TX"
```

Pass when the third call, the `SELECT`, returns the array `uuid`, `text`.

Then check what those casts exist for: an untyped string parameter arrives as `varchar`, as the emulator
binds it (`packages/kit/src/adapters/real/rds-data-emulator.ts`):

```bash
rds execute-statement --database "$DB" --sql "SELECT pg_typeof(:p)::text AS t" \
  --parameters '[{"name":"p","value":{"stringValue":"x"}}]'
```

Pass when it returns `character varying`. If it does not, the emulator is stricter than AWS; correct it.

Then check that a `:` inside a string literal or a comment is not read as a parameter. SSSB's own SQL
has none today, but the emulator assumes AWS's parser skips them, and nothing else has checked:

```bash
rds execute-statement --database "$DB" --sql "SELECT ':not_a_parameter' AS literal -- :nor_this"
```

Pass when the call succeeds and returns the literal unchanged.

Two harder shapes of the same rule: an E-string, where `\'` is a quote inside the literal, and nested
block comments, which Postgres allows. The dialect and the emulator read both the way Postgres does, by one
scanner (`sqlSegments` in `packages/kit/src/adapters/real/rds-data-codec.ts`):

```bash
rds execute-statement --database "$DB" \
  --sql "SELECT E'it\\'s :not_a_parameter' AS a /* outer /* inner :nor_this */ :nor_that */"
```

Pass when it returns `it's :not_a_parameter`. If AWS reads any of the three as a parameter, its scanner is
weaker than Postgres's: make the emulator follow it, and keep such text out of SSSB's SQL.

And check the other side of that rule, an accepted limit in ADR-0002's addendum: a colon directly before
a name outside a literal IS read as a parameter, and a space after the colon stops it:

```bash
rds execute-statement --database "$DB" --sql "SELECT (ARRAY[10,20,30])[1:hi] FROM (SELECT 2 AS hi) AS s"
rds execute-statement --database "$DB" --sql "SELECT (ARRAY[10,20,30])[1 : hi] FROM (SELECT 2 AS hi) AS s"
```

Pass when the first call fails for want of a parameter `hi` and the second returns the elements 10 and 20. If the
first succeeds, AWS's parser is more forgiving than the emulator; correct the addendum's limit.

## 3. The wire format matches the emulator's

```bash
rds execute-statement --database "$DB" --include-result-metadata \
  --result-set-options decimalReturnType=STRING,longReturnType=STRING \
  --sql "SELECT now() AS ts, '2026-10-03'::date AS d, '{2026-10-03}'::date[] AS ds, gen_random_uuid() AS u,
         '{\"a\":1}'::jsonb AS j, 9007199254740993::int8 AS big, 1.5::numeric AS n, true AS b, '\\x00ff'::bytea AS by"
```

The emulator (`packages/kit/src/adapters/real/rds-data-emulator.ts`) assumes the following, and the dialect
decodes on those assumptions. Pass when each holds; for any that does not, fix the decoder and the
emulator together:

- `columnMetadata[].typeName` is Postgres's type name: `timestamptz`, `date`, `_date`, `uuid`, `jsonb`,
  `int8`, `numeric`, `bool`, `bytea`.
- `ts` is a `stringValue` of UTC wall-clock time, `YYYY-MM-DD HH:MM:SS[.ffffff]`, with no zone.
- `big` and `n` are `stringValue`s; `ds` is an `arrayValue` of `stringValues`; `by` is a `blobValue`.

Then the shapes the emulator models but nobody has seen AWS answer:

```bash
rds execute-statement --database "$DB" --include-result-metadata \
  --result-set-options decimalReturnType=STRING,longReturnType=STRING \
  --sql "SELECT 0.0000001::numeric AS tiny, '{9007199254740993}'::int8[] AS bigs, 1.1::float4 AS f,
         B'1' AS bit1, '12:34:56.789'::time AS t"
```

- Check that `tiny` is `0.0000001`, not scientific notation (`1E-7`): the codec passes the string through.
- Check that `bigs`' element is a string, not a JSON number: `longReturnType=STRING` must reach inside an array,
  or an `int8[]` value past 2^53 loses precision silently.
- Check that `f` is `1.1` (not a float32-widened `1.100000023841858`), `bit1` the shape the emulator answers (not a
  `booleanValue`), and `t` keeps its `.789`.
- Check that `numberOfRecordsUpdated` for an `UPDATE … RETURNING` is the number of rows, as the emulator answers:
  `UPDATE tenants SET name = name WHERE slug = (SELECT slug FROM tenants LIMIT 1) RETURNING slug` should say 1.

Then the result types the Data API refuses. AWS names none ("The Data API doesn't support all data types",
its troubleshooting page, whose fix is a cast to `TEXT`), so the emulator refuses what has been seen refused, and
what that evidence implies, in `REFUSED_RESULT_TYPES`:

```bash
rds execute-statement --database "$DB" --sql "SELECT relkind FROM pg_class WHERE false"
rds execute-statement --database "$DB" --sql "SELECT 'abc'::char(3) AS code"
rds execute-statement --database "$DB" --sql "SELECT ARRAY['ab']::char(3)[] AS codes, ARRAY['r']::\"char\"[] AS kinds"
rds execute-statement --database "$DB" --sql "SELECT relkind::text AS kind, 'x'::name AS n, pg_sleep(0) AS v FROM pg_class LIMIT 1"
```

- The first must fail with `UnsupportedResultException` and "The result contains the unsupported data type "CHAR"",
  with no rows to return: the refusal reads the columns. This is what stopped the migrator, whose first statement is
  Kysely's introspection (`RdsDataIntrospector` in `packages/kit/src/adapters/real/rds-data-dialect.ts` casts it).
- Record what the second and third do. The emulator refuses `char(n)` and the arrays on inference (the same JDBC
  type, `CHAR`); for each that AWS answers, take it out of `REFUSED_RESULT_TYPES` and the parity test's casts.
- Record whether a refused statement's write stays: in a transaction you then roll back (`--transaction-id`, as in
  step 1), run
  `INSERT INTO tenants (slug, name) VALUES ('char-probe', 'x') RETURNING 'r'::"char"` (refused), then
  `SELECT count(*) FROM tenants WHERE slug = 'char-probe'` in the same transaction. The emulator runs the statement
  before refusing its result, so it answers 1.
- The last must succeed: the cast, a `name` (Kysely's introspection and the role reads return them) and a `void`
  (the migrator's transaction lock returns one).

Then a response over the 1 MiB cap, in rows that each stay under the 64 KB per row that AWS's
troubleshooting page also lists, so that a failure is the cap's:

```bash
rds execute-statement --database "$DB" --sql "SELECT repeat('x', 60000) AS big FROM generate_series(1, 20)"
```

Pass when it fails. Record the exception's name and message; the emulator answers "Database returned more
than the allowed response size limit". This is the limit a page of rows with unbounded text meets on this
transport where `pg` returns it (ADR-0002's addendum, accepted limits).

Then one row over that 64 KB, which the emulator does not model:

```bash
rds execute-statement --database "$DB" --sql "SELECT repeat('x', 100000) AS big"
```

Record whether it succeeds. If it fails, a text field over 64 KB cannot be read through this transport
at all, even one row at a time: add that to ADR-0002's accepted limits, and to the emulator.

## 4. Errors

```bash
rds execute-statement --database "$DB" --sql "INSERT INTO tenants (slug, name) SELECT slug, name FROM tenants LIMIT 1"
```

This fails with a unique violation. Record the exception's name and its whole message, including whether
it ends `; SQLState: 23505`. The dialect handles both forms (`normalizeDatabaseError` in
`packages/kit/src/adapters/real/rds-data-codec.ts`), but the row should say which one AWS sends.
Check too whether the message carries Postgres's `Detail:` line, which quotes the row's values:
`normalizeDatabaseError` takes the first pattern that matches anywhere in it, so row text could give the wrong
constraint name or code.

Also roll back a transaction id that has already ended, and record that exception's name and message: the
dialect treats `TransactionNotFoundException`, or a message saying the transaction is not found, as already
rolled back (`isTransactionGone` in `packages/kit/src/adapters/real/rds-data-dialect.ts`).

Last, record the exception names for three requests the Data API should refuse before running anything:

```bash
rds execute-statement --database "$DB" --sql "SELECT 1 -- $(head -c 70000 /dev/zero | tr '\0' x)"
rds execute-statement --database "$DB" --sql "SELECT 1 WHERE 1 = ANY(:xs)" \
  --parameters '[{"name":"xs","value":{"arrayValue":{"longValues":[1]}}}]'
rds execute-statement --database "$DB" --sql "SELECT 1; SELECT 2"
```

The emulator names all three `ValidationException`, and the dialect takes that name to mean the request
never reached the database, so a transaction it happened in stays usable. If AWS sends another name
(`BadRequestException`, say), change both: until then the dialect marks that transaction failed. (The dialect
refuses a multistatement itself before calling; the third request checks the emulator's model of AWS.)

## 5. The app on the transport

- **On an EMPTY database.** On the `data-api` network shape the Data API is the migrator's only way in, so
  every migration must be seen to go through it: deploy staging with `params.database.transport` set to
  `'data-api'` (so `DATABASE_TRANSPORT=data-api`) as a new stack, whose new cluster's database (named
  from `APP_SLUG`, each dash an underscore, by `databaseNameFor` in `packages/cdk/src/database-name.js`) no migrator has touched. Point `$CLUSTER`, `$SECRET` and `$DB` at that
  cluster, its secret and that database for the rest of this step. Invoke the migrator Lambda. It must
  return `{ ok: true }`, and then

    ```bash
    rds execute-statement --database "$DB" --sql "SELECT count(*) FROM kysely_migration"
    ```

    must equal the number of migrations the framework and the app register: the entries of
    `packages/kit/src/db/migrations/index.ts` plus those of the app's own, such as
    `apps/showcase/src/app-config/db/migrations/index.ts`. That one run proves on AWS what only the emulator has shown: DDL in
    one Data API transaction, the describe step for the migrator's bookkeeping inserts inside it, and
    the `DO` blocks of 0001 and 0015.

- **The `DO` block, asked on its own.** AWS refuses multistatements. Whether that check looks inside a
  dollar-quoted body, where the `;`s of 0001 and 0015 sit, is not documented:

    ```bash
    rds execute-statement --database "$DB" --sql 'DO $$ BEGIN PERFORM 1; PERFORM 2; END $$'
    ```

    Pass when it succeeds. If AWS refuses it, SSSB changes 0001 and 0015, not the migrator, each moving its
    checks into its TypeScript and sending one statement per call: 0001 checks `pg_roles` for `app_user` and
    sends `CREATE ROLE app_user NOLOGIN` alone; 0015 runs its `pg_has_role` and membership queries, sends the
    one `GRANT` they call for, and raises its own error when that is refused. Those two are the only
    dollar-quoted bodies in SSSB's migrations and both apps'. An
    adopter's PL/pgSQL function would meet the same refusal, and its migration could run only on the `pg`
    shape: on `data-api` nothing but the Data API reaches the database (the first bullet above).

- Invoke the migrator twice at once. Both must return `{ ok: true }`: the second waits on the
  transaction-scoped migration lock and then finds nothing pending.
- Sign in and use a tenant-scoped screen. Then sign in as a member of the second tenant and confirm none
  of the first tenant's rows appear. The database the first bullet migrated starts with no tenants (no
  migration creates one): give it two, each with a member, and rows for the first, before this check.

## 6. A paused cluster

SSSB's own non-production stack runs at minimum capacity 0 (`packages/cdk/src/sssb-app.js`), so its cluster pauses,
and the first request after that wakes it.

**What it costs.** AWS gives a typical resume as about 15 seconds, and 30 seconds or longer once a cluster has been
paused for more than a day
([auto-pause](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html)).
Measured on 2026-11-21, before this wait was reworked: the cluster resumed in 12 to 14 seconds, and the cold request
took 26.0 seconds of the server's 30. A request makes one wait, however many calls it makes, unless it carries on after
one has run out or the database refuses again after answering the poll: the dialect polls with `SELECT 1` after 1, 2
and 4 seconds and then every second, every call that waits shares that poll, and a call outside a transaction that is
not yet sent waits for a known resume first (`packages/kit/src/adapters/real/rds-data-resume.ts`).

**Setting the budget.** A call waits 18 seconds by default, then fails. `DATABASE_RESUME_BUDGET_MS` on the server
changes it (a whole number of milliseconds, 0 to fail at once, at most 900000). In the app's `infra/app.ts`, with the
construct kept (`const sssbApp = new SssbApp(...)`), before `app.synth()`:

```ts
sssbApp.server.addEnvironment('DATABASE_RESUME_BUDGET_MS', '10000')
```

It bounds the wait alone, so leave room under the server's timeout for the rest of the request. Minimum capacity above 0
is what removes the wait. The migrator waits two minutes whatever the server is set to.

**What an app sees.** `DatabaseUnavailableError` (`@sssb/kit/ports/errors`), whose `reason` is `resuming`, `throttled`,
`timed-out` or `unavailable` and whose `cause` is AWS's own error. The starter's `withPortErrors`
(`apps/starter/src/app/api/respond.ts`) answers it with a 503, `Retry-After: 5` and
`{ error: 'database-unavailable', reason }`, and logs a warning. Let the browser repeat a GET by itself. Send a write again only when the person asks:
treat a throttled or timed-out statement as if it may have run (AWS says a timed-out one is cancelled, and nothing of a
throttled one). A page rendered on the server is not covered by `withPortErrors`: keep database calls out of what it
needs for its first paint, or catch the error there.

**Check it live.** Let the cluster pause, then:

- Open a tenant-scoped screen, and record how long its API request took. That request must succeed, or answer a 503
  that a second one a few seconds later does not.
- Read the RDS event log, and record the time between the resume's start and its end, and the same for a cluster paused
  for more than a day.
- Send `rds begin-transaction --database "$DB"` and `rds execute-statement --database "$DB" --sql "SELECT 1"` once a second
  while a fresh pause ends, recording each exception's name and message. The dialect takes `DatabaseResumingException`
  as cancelled, and sends a `BeginTransaction` again after a throttle too. Record whether a `BeginTransaction` ever
  succeeds while a statement in it still answers that the database is resuming.
