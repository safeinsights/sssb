---
'@sssb/kit': patch
---

### The Migrator runs on the RDS Data API

**Kind.** operator

**Action.** optional

**What changed.** On the Data API transport (`DATABASE_TRANSPORT=data-api`) the Migrator failed on its first
statement with `UnsupportedResultException: The result contains the unsupported data type "CHAR"`. That statement is
Kysely's introspection, which selects `pg_class.relkind`, a one-byte `"char"` the Data API cannot return. The Data API
dialect now gives Kysely an introspector that reads the same thing with `relkind` cast to text. The Data API emulator
that `pnpm test:contract` runs on now refuses a result with a `"char"` column, as the Data API does, and also a
`char(n)` column and arrays of either, which the Data API very likely refuses too (the same JDBC type, unconfirmed). So a
statement the contract run sends that returns one fails there instead of live. Nothing changes on the `pg` transport.

**To adopt.** If your Migrator failed this way on the Data API, upgrade `@sssb/kit`, redeploy, and invoke the Migrator
again; it migrates from where the database stands. On the Data API transport, cast a `"char"` or `char(n)` column you
select to text (`code::text`). The contract run checks only the statements it sends (the migrations and the isolation
proofs), not every query your app makes.
