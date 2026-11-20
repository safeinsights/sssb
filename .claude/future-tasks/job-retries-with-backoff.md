# Job retries with backoff

**Priority:** P2 · **Status:** open
**Found by:** `feat/job-notify-on`, 2026-11-19, asked for beside the opt-out from completion notifications. Recorded, not built: it is a slice of its own, and the decisions below come first.

A job SSSB runs is tried once. A handler that throws, a build that fails, an invocation that ends mid-run (the in-process
runner's sweep, `packages/kit/src/adapters/real/jobs-in-process.ts`): each ends the job `failed`, a terminal state with no
way out (`jobStatusMachine`, `packages/kit/src/core/jobs.ts`). Whoever wants it done again submits a new job.

## What an app would use it for

Take an app whose maintenance runs as an hourly scheduled job, written so that **each run is idempotent and time-budgeted**: a run the
invocation's limit cuts off is picked up by the next hour's run, because SSSB has no retry. That is a retry by other
means, with a delay (an hour) the app chose by cadence, not by need. With retries it would:

- keep the hourly schedule (the work is periodic whatever happens), and stop relying on the next run to finish a cut-off
  one: a run that failed or was lost would be tried again in minutes, then later, and a run that never succeeds would
  say so after its last attempt rather than silently once an hour;
- tell a job that is failing for good from one that failed once: today both are a `failed` row, and an hour later the
  next run's outcome is all anyone sees.

Such an app would use retries **instead of** its own resume-next-hour discipline. Whether it can drop that
discipline depends on the first decision below: a handler that is retried is run more than once, so it stays idempotent
whatever SSSB does.

## Decide first

1. **Is a retry the same job or a new one?** The same row keeps one timeline and one id for whoever is watching
   (`job_status_changes`, the dashboard's timeline, a result key under `exports/<tenant>/<org>/<job id>.csv`), but
   `failed` is terminal by design: `recordJobStatus` refuses every hop out of it, and `recordWebhookCompletion`
   (`packages/kit/src/db/jobs.ts:248-249`) answers a redelivery of the same status with `idempotent` and refuses a
   conflicting one on a terminal job. Allowing `failed -> queued`
   (or a new `retrying` status) loosens a rule the webhook's idempotency stands on. A new row per attempt, linked to the
   first by a `retry_of` column, keeps terminal states terminal and gives each attempt its own timeline, at the cost of
   a job list that shows several rows for one piece of work. Sketch the second first: it leaves terminal states terminal.
2. **Opt-in per kind, default none.** A kind says how many attempts it allows and the delays between them, in the seam
   beside `jobNotify` (`@sssb/app-config/jobs`, optional as an export and an entry, as `jobNotify` is, so no adopter
   is made to change). A kind that says nothing runs once, as every kind does today. Reuse the webhook deliveries'
   shape, which already is this machinery for another table: `MAX_DELIVERY_ATTEMPTS`, `backoffDelayMs` and a
   `next_attempt_at` armed pessimistically on claim (`packages/kit/src/core/webhook-events.ts`,
   `packages/kit/src/db/webhooks.ts`).
3. **Who runs the next attempt?** A retry cannot wait inside the invocation that failed (the in-process runner shares a
   30-second server limit, and the process may be what died). It needs a drain: the scheduled tick
   (`/api/webhooks/cron`, `SssbApp`'s `scheduledTick`, every five minutes by default) claims due retries as it claims due
   schedules and due webhook deliveries. So **the tick's period is the floor under any backoff**: a one-minute delay
   runs at the next tick. Say so where a kind sets one.

## How it meets what is already there

- **Idempotency.** A retried handler runs again over the first attempt's partial effects, so handlers must be idempotent,
  and SSSB cannot make them so. It can tell a handler which attempt it is (`ctx.attempt`, from 1) and carry a stable
  key across attempts (the first attempt's job id) for a handler to deduplicate its own side effects on. The guide says
  it in the jobs section. An app whose handler is not idempotent leaves its kind on one attempt.
- **Time budgets.** A budgeted handler returns having done part of the work and succeeds; that is a
  completion, not a failure, and is not retried. A handler cut off by the invocation limit is the lost case below. Retries
  do not extend the limit: each attempt has its own invocation's limit, which is what makes a cut-off run finishable.
- **The sweep.** `sweep` fails a job the in-process runner claimed and left `running` past `IN_PROCESS_LOST_AFTER_MS`
  (`safeinsights/sssb#67`). With retries a swept job becomes eligible for its next attempt instead of failing for good,
  and fails for good only when its attempts are spent. The sweep is also the only detector of a lost job, and it looks
  only at jobs the in-process runner claimed: a CodeBuild build that dies without posting its webhook is never noticed
  (no claim message, and no runner to sweep it). Retries on CodeBuild need that gap closed first, or a lost build is
  never retried.
- **The audit trail.** The timeline (`job_status_changes`) records each hop with a message, so each attempt and its
  reason need a row ("attempt 2 of 3 after: <error>", "retry armed for <time>"). Whether a retry writes an
  `audit_events` row is the question `.claude/future-tasks/machine-status-reports-unaudited.md` already asks of a
  status report: answer them together, and the timeline may be the record. Never lose the first attempt's error when a
  later attempt succeeds.
- **Notifications.** An attempt that will be retried does not notify: `jobNotify` (`always`, `failure`, `never`) is
  about a job's final outcome, so `failure` means a failure with no attempts left, and the intermediate failures are
  timeline rows. The notification's payload gains the attempt count, so the bell says "failed after 3 attempts".
- **The webhook.** `recordWebhookCompletion` must treat a failure with attempts left as "arm a retry", not as terminal,
  and a redelivered failure for an attempt already retried is still `idempotent`.

## The runners it must work on

All three, or a kind that sets retries behaves differently in dev than deployed, which the simulated world exists to
prevent:

- **Simulated** (`packages/kit/src/adapters/fake/jobs.ts`): the held flag and "run pending" step a retry as they step a
  queued job, and the Simulator's clock jump lets a demo reach a backoff without waiting.
- **In-process** (`jobs-in-process.ts`): the claim, the sweep and the tick drain above.
- **CodeBuild** (`adapters/real/jobs.ts`, the jobs webhook route): a retry starts another build; the failed build's
  webhook arms it.
- **The static demo's twin** (`packages/kit/src/demo-static/world.ts`): it only ever completes a job today, so retries
  need it to be able to fail one first.

## Proof

Each runner, each of: succeeds first time, fails then succeeds, fails every attempt, is lost then succeeds; and the
timeline, the notification and the redelivered webhook for each. Seen red first.
