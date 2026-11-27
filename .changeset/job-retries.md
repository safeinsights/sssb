---
'@sssb/kit': minor
'@sssb/tools': patch
---

### A job kind can opt in to retries with backoff

**Kind.** seam

**Action.** optional

**What changed.** A job used to be tried once: a failure, or a job the in-process runner lost, ended it `failed` for
good. A kind may now say, in the seam's optional `jobRetry` export (`@sssb/app-config/jobs`, beside `jobNotify`), how
many attempts it allows (at most 10) and the delays between them (each at most 30 days; an entry past either limit is
ignored and the kind runs once). Each attempt is a job row of its own: the failed one
stays `failed`, and the next is queued until its delay has passed. The scheduled tick then starts it, so the tick's
period is the floor under every delay. A handler is told `ctx.attempt` and `ctx.firstJobId`, a key that stays the same
across attempts. Only the last attempt's outcome notifies, and a failure after several attempts says how many. A kind
that says nothing runs once, as before. The tick gains a third drain, so its windows are now 6 seconds for schedules,
10 for retries and 16 for deliveries, and the cron route's JSON gains a `retries` part. `runScheduledTick`'s budget
takes `maxRetries` and `retriesWindowMs`. The job views carry `attempt` and `retryOf`, and a service caller's job list
(`listServiceJobs`) leaves out a retry still waiting. `pnpm tick` reports retries.

**To adopt.** For a kind whose handler is idempotent, add to `src/app-config/jobs.ts`:
`export const jobRetry: Partial<Record<AppJobKind, JobRetry>> = { 'sweep-items': { attempts: 3, delaysMs: [60_000, 600_000] } }`,
with `JobRetry` from `@sssb/kit/core/jobs`. Key the handler's side effects on `ctx.firstJobId`. If the static demo
starts the kind, pass the same map as `useDemoWorld`'s `jobRetry`.

**Now deletable.** A kind's own resume-at-the-next-scheduled-run discipline, kept only so that a failed or cut-off run
was picked up an hour later.
