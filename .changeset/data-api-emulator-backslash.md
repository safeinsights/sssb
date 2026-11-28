---
'@sssb/kit': minor
---

### The contract run catches a backslash literal the Data API refuses

**Kind.** seam

**Action.** required

**What changed.** On the RDS Data API transport, a query with a plain string literal that ends in a backslash and a
parameter after it (`ESCAPE '\'`, as seen live) failed on a real cluster with `syntax error at or near ":"`: the Data
API's own parameter scanner evidently does not see the literal close. The Data API emulator that `pnpm test:contract` runs now reads
parameters the same way, so such a query fails the contract run with the same error instead of passing it. Nothing changes
on the `pg` transport, and the dialect's own behaviour on a real cluster is unchanged. SSSB's Data API runbook (in SSSB's
repository, `docs/runbooks/data-api.md`, step 2) has the live check. A contract run that passed before can fail now; when
it does, the same query was already failing on a real cluster.

**To adopt.** If your contract run now fails with that error, write the one backslash in a form both scanners read
alike. The simplest is `chr(92)`, which has no backslash in its text at all:

```ts
sql`${sql.ref('name')} LIKE ${pattern} ESCAPE chr(92)`
```

Or an escape-string literal, which in SQL text is `E'\\'` (an `E` string, inside which two backslashes are one). Mind the
TypeScript source: a `sql` template reads its text with JavaScript's own escapes applied, so in source that SQL is written
with four backslashes, `` sql`... ESCAPE E'\\\\'` ``; written with two, the database receives `E'\'`, an unterminated string.
Do not write a plain `'\\'` in source either: JavaScript makes it `'\'`, the very literal that fails.
