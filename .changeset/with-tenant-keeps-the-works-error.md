---
'@sssb/kit': patch
---

### A failed rollback no longer replaces the error that made the transaction roll back

**Kind.** none

**Action.** none

**What changed.** When the work inside `db.withTenant()` throws, Kysely rolls the transaction back, and a rollback that
fails in turn used to replace the work's error with its own: a handler that threw `ForbiddenError` reached the route as
a `DatabaseUnavailableError` (a 503, not a 403) when the Data API throttled or timed out the rollback. `withTenant` now
throws the work's own error, with the rollback's failure kept on it as a non-enumerable `rollbackError` property (where
the error is an object that takes one) and logged as a warning. The same holds on the `pg` transport. A rollback you
make yourself, through a controlled transaction (`startTransaction()`, then `rollback()`), still fails as it did, and a
transaction opened on the raw handle (`getDb().transaction()`) keeps Kysely's own behaviour. A failed commit is thrown
as it was.
