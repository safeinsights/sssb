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
that `pnpm test:contract` runs on refuses a result with a `"char"` or `char(n)` column, as the Data API does, so a query
that would hit this fails the contract run. Nothing changes on the `pg` transport.

**To adopt.** If your Migrator failed this way on the Data API, upgrade `@sssb/kit`, redeploy, and invoke the Migrator
again; it migrates from where the database stands. A query of your own that the Data API transport runs cannot return a
`"char"` or `char(n)` column: cast it to text (`code::text`). `pnpm test:contract` now says where one does.
