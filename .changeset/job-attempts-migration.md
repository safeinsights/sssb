---
'@sssb/kit': minor
---

### Framework migration 0019: a job's attempt, its first attempt, and when a retry may run

**Kind.** migration

**Action.** none

**What changed.** Framework migration `0019_job_attempts` adds three columns to `jobs`: `attempt` (from 1; every
existing row is attempt 1), `retry_of` (the first attempt's id on a retry, a foreign key to `jobs`), and `run_after` (set
only on a retry waiting out its delay). It also adds two partial indexes. The migrator applies it on its next run, after
any app migrations a database has already run, which the order-independence rule allows. It is numbered 0019, after
`0018_organizations_write`, which 0.9.0 added.
