---
'@sssb/kit': patch
---

### The contract run catches a backslash literal the Data API refuses

**Kind.** operator

**Action.** optional

**What changed.** On the RDS Data API transport, a query with a plain string literal that ends in a backslash and a
parameter after it (`ESCAPE '\'` is the usual one) fails on a real cluster with `syntax error at or near ":"`: the Data
API's own parameter scanner does not see the literal close. The Data API emulator that `pnpm test:contract` runs now reads
parameters the same way, so such a query fails the contract run with the same error instead of passing it. Nothing changes
on the `pg` transport, and the dialect itself is unchanged. The runbook (`docs/runbooks/data-api.md`, step 2) has the live
check.

**To adopt.** If your contract run now fails with that error, write the one backslash so both scanners read it alike:
`E'\\'` or `chr(92)` (`LIKE … ESCAPE E'\\'`). Plain `'\\'` is two backslashes to Postgres, so it is no substitute where the
literal must be one character, as `ESCAPE` requires.
