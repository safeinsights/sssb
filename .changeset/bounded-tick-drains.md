---
'@sssb/kit': patch
'@sssb/tools': patch
---

### A scheduled tick is bounded, and fair across tenants

**Kind.** none

**Action.** none

**What changed.** `runScheduledTick` (`@sssb/kit/server-lib/scheduled-tick`) used to drain every due schedule and
every due webhook delivery of every tenant, one tenant's backlog after another's, so a long backlog or a slow endpoint
could run the cron route past the server's limit and leave later tenants waiting. A tick now spawns at most 100 due
schedules, none after its first 6 seconds (of which the first 2 are the lost-job sweep's), and attempts at most 100 due deliveries, none after 16, taking each
tenant's due rows in turn, the tenants in a fresh random order every tick. What a tick leaves stays due for the next one,
untouched. The route's JSON gains `deferred` and `stoppedBy`, for schedules and inside `deliveries`; `runDueSchedules`
and `runDueDeliveries` take an optional budget as a last argument (called without one they still drain every due
row), and `runScheduledTick` takes optional `{ budget }` for a server whose limit differs. `pnpm tick` and the dev
ticker say when a tick stopped on its bound and what it left.

A drain lists tenants for at most half of what is left of its window, and runs what it listed in the rest. With more
tenants than that half can list (each a transaction of its own: about four calls on the RDS
Data API), each tick serves a fresh random set of them, and the others wait for a later tick.

On an RDS Data API stack whose Aurora cluster can pause (minimum capacity 0, `SssbApp`'s default outside production),
the tick that wakes the cluster first waits for it to resume, 12 to 14 seconds when measured. Every window runs from
the tick's start, so that tick may judge no lost jobs, spawn no schedules and start no retries; the next tick, on a running cluster, does.
