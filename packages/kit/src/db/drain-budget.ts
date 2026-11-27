/**
 * How much one drain of the scheduled tick may start, and the order it starts it in (safeinsights/sssb#97). Both
 * drains, `runDueSchedules` (./schedules.ts) and `runDueDeliveries` (./webhooks.ts), list each tenant's due rows and
 * hand them here.
 *
 * THE BOUND. A drain stops starting rows once it has started `maxItems`, or once its `deadline` has passed on the
 * wall clock (`clock`, `Date.now` by default: the server's time limit is wall-clock time, so a simulated world clock
 * never moves it). Work already started is never cut short; the bound is on what is STARTED, so the deadline has to
 * leave room for the longest item after it (`runScheduledTick` sets both drains' deadlines with that margin).
 *
 * FAIRNESS. Each tenant's due rows form a queue, oldest due first; the drain takes one row from each tenant in turn
 * (round-robin), so no tenant gets a second turn while another with due work has had none, and a tenant with a
 * thousand due rows, or one slow endpoint, costs every other tenant at most one of its turns per round. The tenants
 * themselves go in order of their oldest due row: a tenant left out when a tick ran out keeps that row, which only
 * grows older, while the rows of the tenants it served were claimed and moved on, so the next tick serves it first.
 * Nothing about the order is stored.
 *
 * THE REMAINDER. A row the drain does not start is not touched: no claim, no lock, no write. It is still due, and the
 * next tick lists it again. Nothing is lost, and nothing runs twice, since running twice is what each drain's own
 * locked re-check already prevents (two ticks that overlap included).
 */

/** What one drain may start in a tick. */
export interface DrainBudget {
    /** The most due rows the drain starts, a positive whole number. */
    maxItems: number
    /** The instant, in `clock`'s milliseconds, after which the drain starts nothing new. */
    deadline: number
    /** The clock `deadline` is read against: `Date.now` unless a test passes its own. */
    clock?: () => number
}

/** Why a drain stopped before it ran out of due rows: it started `maxItems`, or its deadline passed. */
export type DrainStop = 'items' | 'time'

/** What a drain left for a later tick. */
export interface DrainLeft {
    /**
     * Due rows the drain listed and did not start, which the next tick lists again. A lower bound: a drain lists at
     * most one row more than `maxItems` for each tenant (enough to know it stopped on its bound, since no tick could
     * start more of one tenant's), and a drain whose deadline had passed before it began lists none.
     */
    deferred: number
    /** What stopped the drain, or null when it started every due row it listed. */
    stoppedBy: DrainStop | null
}

/** One tenant's due rows, oldest due first, as a drain lists them. */
export interface TenantQueue<T> {
    tenantId: string
    /** Oldest due first; `due` is the row's due instant in milliseconds. */
    rows: readonly (T & { due: number })[]
}

/** The most due rows of each kind one tick starts, unless the caller says otherwise. */
export const DEFAULT_DRAIN_MAX_ITEMS = 100

/*
 * The default windows, from the tick's start, in which each drain may START work. They are sized to the server's
 * 30-second limit (@sssb/cdk's `SssbApp`; the tick runs inside the cron route's request), counted from the start of the
 * request: schedules first, then deliveries, so schedules may start work for 8 seconds and deliveries until 16. A
 * delivery started at 16 seconds may take the POST's 10 (`WEBHOOK_TIMEOUT_MS`, ../server-lib/webhook-dispatch.ts)
 * plus its claim, record and audit transactions, which leaves about four seconds for those and the response. Giving
 * deliveries a window of their own means a run of schedules cannot spend the whole tick: deliveries always get from
 * where schedules stopped until 16 seconds. A schedule's spawn under the in-process jobs runner runs the job itself
 * (`jobs.start`), which no window can bound; such work belongs on a runner with compute of its own.
 */
/** How long after the tick's start the schedules drain may start a spawn. */
export const SCHEDULES_WINDOW_MS = 8_000
/** How long after the tick's start the deliveries drain may start a delivery. */
export const DELIVERIES_WINDOW_MS = 16_000

/**
 * The budget a drain uses when its caller passes none: `DEFAULT_DRAIN_MAX_ITEMS`, and a deadline `windowMs` from now.
 * `runScheduledTick` passes its own, measured from the tick's start rather than from each drain's.
 */
export function drainBudgetOrDefault(budget: DrainBudget | undefined, windowMs: number): DrainBudget {
    const resolved = budget ?? { maxItems: DEFAULT_DRAIN_MAX_ITEMS, deadline: Date.now() + windowMs }
    checkDrainBudget(resolved)
    return resolved
}

/** Refuses a budget no drain can honour, so a typo fails the tick loudly instead of draining nothing. */
function checkDrainBudget(budget: DrainBudget): void {
    if (!Number.isInteger(budget.maxItems) || budget.maxItems < 1) {
        throw new RangeError(`a drain budget's maxItems must be a whole number, at least 1 (got ${budget.maxItems})`)
    }
    if (!Number.isFinite(budget.deadline)) {
        throw new RangeError(`a drain budget's deadline must be a finite instant (got ${budget.deadline})`)
    }
}

/** Whether the drain may still begin: its deadline has not passed. Checked before it lists anything. */
export function drainMayStart(budget: DrainBudget): boolean {
    return (budget.clock ?? Date.now)() < budget.deadline
}

/**
 * Runs `run` over the queues' rows in the fair order above until the rows or the budget run out. `run` isolates its
 * own failures (each drain counts them); one that throws anyway stops the drain, as an unhandled error did before.
 */
export async function drainFairly<T>(
    queues: readonly TenantQueue<T>[],
    budget: DrainBudget,
    run: (row: T & { due: number }, tenantId: string) => Promise<void>,
): Promise<DrainLeft> {
    const clock = budget.clock ?? Date.now
    const ordered = queues
        .filter((q) => q.rows.length > 0)
        .sort(
            (a, b) =>
                a.rows[0]!.due - b.rows[0]!.due || (a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0),
        )
    const total = ordered.reduce((sum, q) => sum + q.rows.length, 0)
    const rounds = ordered.reduce((most, q) => Math.max(most, q.rows.length), 0)
    let started = 0
    for (let round = 0; round < rounds; round++) {
        for (const queue of ordered) {
            const row = queue.rows[round]
            if (row === undefined) continue
            if (started >= budget.maxItems) return { deferred: total - started, stoppedBy: 'items' }
            if (clock() >= budget.deadline) return { deferred: total - started, stoppedBy: 'time' }
            started += 1
            await run(row, queue.tenantId)
        }
    }
    return { deferred: 0, stoppedBy: null }
}
