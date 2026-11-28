import { worldNow } from '../adapters/fake/clock'
import { db, isSimulated, jobs } from '../adapters/index'
import {
    DEFAULT_DRAIN_MAX_ITEMS,
    DELIVERIES_WINDOW_MS,
    RETRIES_WINDOW_MS,
    SCHEDULES_WINDOW_MS,
    SWEEP_WINDOW_MS,
} from '../db/drain-budget'
import { runDueRetries } from '../db/jobs'
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
 * The same tick starts due job retries (safeinsights/sssb#135: a failed attempt of a kind that retries, once its delay
 * has run out) and drains due webhook deliveries: a scheduled digest that spawns a job whose status change enqueues a
 * delivery, and any delivery retry whose backoff has elapsed, both fire from one tick.
 *
 * A tick is BOUNDED (safeinsights/sssb#97): each drain starts at most a set number of rows and none after its window,
 * taking each tenant's due rows in turn so one tenant's backlog or slow endpoint cannot starve the rest
 * (../db/drain-budget.ts). What a tick leaves stays due and the next tick takes it; the result says how much was left
 * (`deferred`) and why (`stoppedBy`), for schedules, for job retries and for deliveries.
 */
export interface ScheduledTickResult {
    /** Jobs spawned from due schedules. */
    spawned: number
    /**
     * Due schedules whose spawn failed. One that failed inside the spawn transaction is backed off, or turned off when
     * its spec does not parse (safeinsights/sssb#215); one that failed after it committed (the audit write, the
     * runner's start) is not retried: its job is already queued and the schedule has moved to its next slot
     * (../db/schedules.ts, "Fault isolation").
     */
    failed: number
    /** Due schedules this tick listed and left for the next one (a lower bound: ../db/drain-budget.ts). */
    deferred: number
    /** What stopped the schedules drain early: `'items'` (its row bound), `'time'` (its window), or null. */
    stoppedBy: 'items' | 'time' | null
    /** What the job-retry drain did, and left (`runDueRetries`'s own result): retries started, and ones that failed to. */
    retries: Awaited<ReturnType<typeof runDueRetries>>
    /** What the delivery drain did, and left (`runDueDeliveries`'s own result). */
    deliveries: Awaited<ReturnType<typeof runDueDeliveries>>
}

/**
 * How much one tick may start (../db/drain-budget.ts, safeinsights/sssb#97). The defaults suit SSSB's deployment, a
 * server with a 30-second limit: change them only for a server whose limit differs, or to drain less per tick.
 */
export interface TickBudget {
    /** The most lost jobs one tick's sweep fails (safeinsights/sssb#252); optional, so a full budget written before it still is one. */
    maxSweep?: number
    /** Milliseconds from the tick's start after which the sweep judges no more jobs; optional, as `maxSweep`. */
    sweepWindowMs?: number
    /** The most due schedules one tick spawns. */
    maxSchedules: number
    /** The most due job retries one tick starts. */
    maxRetries: number
    /** The most due webhook deliveries one tick attempts. */
    maxDeliveries: number
    /** Milliseconds from the tick's start after which no schedule is spawned. */
    schedulesWindowMs: number
    /** Milliseconds from the tick's start after which no job retry is started. */
    retriesWindowMs: number
    /** Milliseconds from the tick's start after which no delivery is attempted. */
    deliveriesWindowMs: number
}

const DEFAULT_TICK_BUDGET: Required<TickBudget> = {
    maxSweep: DEFAULT_DRAIN_MAX_ITEMS,
    sweepWindowMs: SWEEP_WINDOW_MS,
    maxSchedules: DEFAULT_DRAIN_MAX_ITEMS,
    maxRetries: DEFAULT_DRAIN_MAX_ITEMS,
    maxDeliveries: DEFAULT_DRAIN_MAX_ITEMS,
    schedulesWindowMs: SCHEDULES_WINDOW_MS,
    retriesWindowMs: RETRIES_WINDOW_MS,
    deliveriesWindowMs: DELIVERIES_WINDOW_MS,
}

/**
 * Runs one tick: the jobs port's sweep, then the due schedules, then the due job retries, then the due deliveries, each drain bounded by
 * `options.budget` (the defaults, for any value left out) and fair across tenants. `options.clock` is the wall clock
 * the windows are read against, `Date.now` unless a test passes its own; it never sets "now" for what is due. `options.random`
 * is the draws that shuffle the tenants and their rows, `Math.random` unless a test passes its own.
 */
export async function runScheduledTick(
    options: {
        budget?: { [K in keyof TickBudget]?: TickBudget[K] | undefined }
        clock?: () => number
        random?: () => number
    } = {},
): Promise<ScheduledTickResult> {
    const clock = options.clock ?? Date.now
    const startedAt = clock()
    // Field by field, so a field given as `undefined` (an unset environment value, say) means the default, never a hole.
    const given = options.budget ?? {}
    const budget: Required<TickBudget> = {
        maxSweep: given.maxSweep ?? DEFAULT_TICK_BUDGET.maxSweep,
        sweepWindowMs: given.sweepWindowMs ?? DEFAULT_TICK_BUDGET.sweepWindowMs,
        maxSchedules: given.maxSchedules ?? DEFAULT_TICK_BUDGET.maxSchedules,
        maxRetries: given.maxRetries ?? DEFAULT_TICK_BUDGET.maxRetries,
        maxDeliveries: given.maxDeliveries ?? DEFAULT_TICK_BUDGET.maxDeliveries,
        schedulesWindowMs: given.schedulesWindowMs ?? DEFAULT_TICK_BUDGET.schedulesWindowMs,
        retriesWindowMs: given.retriesWindowMs ?? DEFAULT_TICK_BUDGET.retriesWindowMs,
        deliveriesWindowMs: given.deliveriesWindowMs ?? DEFAULT_TICK_BUDGET.deliveriesWindowMs,
    }
    const now = isSimulated ? worldNow() : new Date()
    // A runner that can lose a job mid-run (JOBS_RUNNER=in-process) fails the lost ones first; its own count is not
    // reported here, the failed jobs' errors say it.
    try {
        await jobs.sweep?.(now, {
            maxItems: budget.maxSweep,
            deadline: startedAt + budget.sweepWindowMs,
            clock,
            ...(options.random && { random: options.random }),
        })
    } catch (error) {
        // A sweep that fails must not stop the schedules and deliveries behind it.
        console.warn(
            `SSSB tick: the jobs port's sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        )
    }
    // Every window runs from the tick's start, so the sweep and the drains before count against a later drain's window
    // too, and each keeps the part of its window the ones before it leave.
    const { spawned, failed, deferred, stoppedBy } = await runDueSchedules(db, jobs, now, {
        maxItems: budget.maxSchedules,
        deadline: startedAt + budget.schedulesWindowMs,
        clock,
        ...(options.random && { random: options.random }),
    })
    const retries = await runDueRetries(
        db,
        jobs,
        now,
        {
            maxItems: budget.maxRetries,
            deadline: startedAt + budget.retriesWindowMs,
            clock,
            ...(options.random && { random: options.random }),
        },
        notifyRetryEnd,
    )
    const deliveries = await runDueDeliveries(db, now, dispatchWebhook, {
        maxItems: budget.maxDeliveries,
        deadline: startedAt + budget.deliveriesWindowMs,
        clock,
        ...(options.random && { random: options.random }),
    })
    return { spawned, failed, deferred, stoppedBy, retries, deliveries }
}

/**
 * A retry whose start threw has been recorded failed; when it was the last attempt, that is the job's end, so it notifies
 * as every runner's failure does (`notifyJobTerminal` skips one that armed a further attempt). The Simulator's clock and
 * run-due controls pass it to `runDueRetries` too. Loaded when it is needed:
 * the notifier reaches the adapter registry's auth port, which a tick that starts every retry never touches.
 */
export async function notifyRetryEnd(input: { tenantId: string; jobId: string }): Promise<void> {
    const [{ notifyJobTerminal }, { makeNotifyDeps }, { auth }] = await Promise.all([
        import('./notify'),
        import('./notify-deps'),
        import('../adapters/index'),
    ])
    await notifyJobTerminal(await makeNotifyDeps(), auth, { ...input, status: 'failed' })
}
