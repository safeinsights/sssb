---
'@sssb/kit': minor
---

### Framework migrations 0020 and 0021: a job's build, and a schedule's failures

**Kind.** migration

**Action.** none

**What changed.** Framework migration `0020_job_runner_ref` adds a nullable `runner_ref` to `jobs`, where the CodeBuild
runner records each job's build. `0021_schedule_failures` adds `failure_count` (default 0) and a nullable `last_error`
to `job_schedules`. The migrator applies both on its next run, after any app migrations a database has already run,
which the order-independence rule allows.
