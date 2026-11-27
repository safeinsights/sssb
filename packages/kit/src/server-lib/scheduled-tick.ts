import { worldNow } from '../adapters/fake/clock'
import { db, isSimulated, jobs } from '../adapters/index'
import { DEFAULT_DRAIN_MAX_ITEMS, DELIVERIES_WINDOW_MS, SCHEDULES_WINDOW_MS } from '../db/drain-budget'
import { runDueSchedules } from '../db/schedules'
import { runDueDeliveries } from '../db/webhooks'
import { dispatchWebhook } from './webhook-dispatch'

/**
 * The scheduled-work tick: drains every due `job_schedules` row (spawning its job) and every due outbound
 * webhook delivery, and says how many of each. It is the whole body of an app's `/api/webhooks/cron` route, so
 * that route is a three-line wrapper (`withWebhookSecret(async () => Response.json({ ok: true, ...(await
 * runScheduledTick()) }))`) and an app that takes SSSB as a package gets the same behaviour as a fork.
 *
 * Real world: an EventBridge rule POSTs that route on a fixed cadence with the shared secret in `x-sssb-webhook-secret`
 * (cutover row `scheduled-tick`; @sssb/cdk's `SssbApp` does it with `scheduledTick`). Nothing else ticks the scheduler: in `pnpm dev` an app with no Simulator has no
 * tick source until something POSTs the route (docs/adopting-reference.md, "The scheduled tick").
 *
 * "Now" is the trigger source's clock: real time in a real build; in a simulated world the Simulator's world clock
 * (real time plus the offset a demo advanced), so a tick honours a clock the demo moved. `worldNow()` is called
 * only behind `isSimulated`, so that offset is structurally unreachable in a real build.
 *
 * The same tick drains due webhook deliveries: a scheduled digest that spawns a job whose status change
 * enqueues a delivery, and any retry whose backoff has elapsed, both fire from one tick.
 *
 * A tick is BOUNDED (safeinsights/sssb#97): each drain starts at most a set number of rows and none after its window,
 * taking each tenant's due rows in turn so one tenant's backlog or slow endpoint cannot starve the rest
 * (../db/drain-budget.ts). What a tick leaves stays due and the next tick takes it; the result says how much was left
 * (`deferred`) and why (`stoppedBy`), for schedules and for deliveries.
 */
export interface ScheduledTickResult {
    /** Jobs spawned from due schedules. */
    spawned: number
    /**
     * Due schedules whose spawn failed. One that failed inside the spawn transaction is retried on the next tick (its
     * next_run_at never advanced); one that failed after it committed (the audit write, the runner's start) is not:
     * its job is already queued and the schedule has moved to its next slot (../db/schedules.ts, "Fault isolation").
     */
    failed: number
    /** Due schedules this tick listed and left for the next one (a lower bound: ../db/drain-budget.ts). */
    deferred: number
    /** What stopped the schedules drain early: `'items'` (its row bound), `'time'` (its window), or null. */
    stoppedBy: 'items' | 'time' | null
    /** What the delivery drain did, and left (`runDueDeliveries`'s own result). */
    deliveries: Awaited<ReturnType<typeof runDueDeliveries>>
}

/**
 * How much one tick may start (../db/drain-budget.ts, safeinsights/sssb#97). The defaults suit SSSB's deployment, a
 * server with a 30-second limit: change them only for a server whose limit differs, or to drain less per tick.
 */
export interface TickBudget {
    /** The most due schedules one tick spawns. */
    maxSchedules: number
    /** The most due webhook deliveries one tick attempts. */
    maxDeliveries: number
    /** Milliseconds from the tick's start after which no schedule is spawned. */
    schedulesWindowMs: number
    /** Milliseconds from the tick's start after which no delivery is attempted. */
    deliveriesWindowMs: number
}

const DEFAULT_TICK_BUDGET: TickBudget = {
    maxSchedules: DEFAULT_DRAIN_MAX_ITEMS,
    maxDeliveries: DEFAULT_DRAIN_MAX_ITEMS,
    schedulesWindowMs: SCHEDULES_WINDOW_MS,
    deliveriesWindowMs: DELIVERIES_WINDOW_MS,
}

/**
 * Runs one tick: the jobs port's sweep, then the due schedules, then the due deliveries, each drain bounded by
 * `options.budget` (the defaults, for any value left out) and fair across tenants. `options.clock` is the wall clock
 * the windows are read against, `Date.now` unless a test passes its own; it never sets "now" for what is due.
 */
export async function runScheduledTick(
    options: { budget?: Partial<TickBudget>; clock?: () => number } = {},
): Promise<ScheduledTickResult> {
    const clock = options.clock ?? Date.now
    const startedAt = clock()
    const budget = { ...DEFAULT_TICK_BUDGET, ...options.budget }
    const now = isSimulated ? worldNow() : new Date()
    // A runner that can lose a job mid-run (JOBS_RUNNER=in-process) fails the lost ones first; its own count is not
    // reported here, the failed jobs' errors say it.
    try {
        await jobs.sweep?.(now)
    } catch (error) {
        // A sweep that fails must not stop the schedules and deliveries behind it.
        console.warn(
            `SSSB tick: the jobs port's sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        )
    }
    // Both windows run from the tick's start, so the sweep and the schedules count against the deliveries' window too,
    // and deliveries keep the part of it that schedules leave.
    const { spawned, failed, deferred, stoppedBy } = await runDueSchedules(db, jobs, now, {
        maxItems: budget.maxSchedules,
        deadline: startedAt + budget.schedulesWindowMs,
        clock,
    })
    const deliveries = await runDueDeliveries(db, now, dispatchWebhook, {
        maxItems: budget.maxDeliveries,
        deadline: startedAt + budget.deliveriesWindowMs,
        clock,
    })
    return { spawned, failed, deferred, stoppedBy, deliveries }
}
