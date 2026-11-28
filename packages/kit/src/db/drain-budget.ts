/**
 * How much one drain of the scheduled tick may start, and the order it starts it in (safeinsights/sssb#97). Both
 * drains, `runDueSchedules` (./schedules.ts) and `runDueDeliveries` (./webhooks.ts), list each tenant's due rows and
 * hand them here.
 *
 * THE BOUND. A drain stops starting rows once it has started `maxItems`, or once its `deadline` has passed on the
 * wall clock (`clock`, `Date.now` by default: the server's time limit is wall-clock time, so a simulated world clock
 * never moves it). The deadline is checked before each row, so past it a drain starts nothing more. Listing has a
 * deadline of its own, `LISTING_SHARE` of the way from the drain's start to its deadline, checked before each tenant's
 * listing query: past it the drain lists no more tenants and runs what it has, so a drain over more tenants than its
 * window can list still starts work every tick (the tenants it did not list are a fresh random set each tick). Work already started is never cut short; the bound is on what is
 * STARTED, so the deadline has to leave room for the longest item after it (`runScheduledTick` sets each drain's
 * deadline with that margin). A drain called with no budget at all is unbounded, as every drain was before the bound:
 * the tick always passes one, and the Simulator's own controls, which run no server limit, pass none.
 *
 * FAIRNESS. Each tenant's listed due rows form a queue; the drain takes one row from each tenant in turn
 * (round-robin), so no tenant gets a second turn while another with due work has had none, and a tenant with a
 * thousand due rows, or one slow endpoint, costs every other tenant at most one of its turns per round. The order of the
 * tenants is a fresh uniform shuffle every tick (`random`, `Math.random` by default), the same order for the listing and
 * for the turns, so a tick that can serve only some of the tenants with due work serves each with the same chance,
 * whatever the others hold and wherever their ids fall. Under a bound a tenant's own listed rows (its oldest due, up to
 * the listing limit) are shuffled too, so a row that fails every time and stays due cannot take that tenant's first
 * turn every tick; with no bound every row runs, and each tenant's keep their oldest-first order. Nothing about the
 * order is stored.
 *
 * THE REMAINDER. A row the drain does not start is not touched: no claim, no lock, no write. It is still due, and the
 * next tick lists it again. Nothing is lost, and nothing runs twice, since running twice is what each drain's own
 * locked re-check already prevents (two ticks that overlap included).
 */

/** What one drain may start in a tick. */
export interface DrainBudget {
    /** The most due rows the drain starts: a positive whole number, or `Infinity` for no bound. */
    maxItems: number
    /** The instant, in `clock`'s milliseconds, after which the drain starts nothing new; `Infinity` for no bound. */
    deadline: number
    /** The clock `deadline` is read against: `Date.now` unless a test passes its own. */
    clock?: () => number
    /** The draws, from [0, 1), that shuffle the tick's order: `Math.random` unless a test passes its own. */
    random?: () => number
}

/** Why a drain stopped before it ran out of due rows: it started `maxItems`, or its deadline passed. */
export type DrainStop = 'items' | 'time'

/** What a drain left for a later tick. */
export interface DrainLeft {
    /**
     * Due rows the drain listed and did not start, which the next tick lists again. A lower bound: a drain lists at
     * most one row more than `maxItems` for each tenant (enough to know it stopped on its bound, since no tick could
     * start more of one tenant's), and lists no tenant once its listing deadline (`LISTING_SHARE`) has passed.
     */
    deferred: number
    /** What stopped the drain, or null when it started every due row there was. */
    stoppedBy: DrainStop | null
}

/** One tenant's listed due rows, in the order the drain takes them. */
export interface TenantQueue<T> {
    tenantId: string
    rows: readonly T[]
}

/** The most due rows of each kind one tick starts, unless the caller says otherwise. */
export const DEFAULT_DRAIN_MAX_ITEMS = 100

/*
 * The default windows, from the tick's start, in which each drain may START work. They are sized to the server's
 * 30-second limit (@sssb/cdk's `SssbApp`, `packages/cdk/src/sssb-app.js:526` in SSSB's repository; the tick runs inside
 * the cron route's request), counted from the start of the request: the jobs port's sweep first (`SWEEP_WINDOW_MS`, its
 * first 2 seconds, safeinsights/sssb#252), then schedules, then job retries, then deliveries, so schedules may start work
 * until 6 seconds, retries until 10 and deliveries until 16. A delivery started at 16 seconds
 * may take the POST's 10 (`WEBHOOK_TIMEOUT_MS`, ../server-lib/webhook-dispatch.ts) plus its claim, record and audit
 * transactions, which leaves about four seconds for those, the drain's other queries (its listing stops halfway, `LISTING_SHARE`), and the
 * response. Giving each drain a window of its own means none can spend the whole tick: retries always get from where
 * schedules stopped until 10 seconds, deliveries from there until 16. A schedule's spawn and a retry's start under the
 * in-process jobs runner run the job itself (`jobs.start`), which no window can bound; such work belongs on a runner
 * with compute of its own. A change to the server's timeout has to change these too.
 */
/**
 * How long after the tick's start the jobs port's sweep may judge lost jobs (safeinsights/sssb#252): two seconds, the
 * first part of the schedules' window, so a sweep that finds many lost jobs leaves the drains most of theirs.
 */
export const SWEEP_WINDOW_MS = 2_000
/** How long after the tick's start the schedules drain may start a spawn. */
export const SCHEDULES_WINDOW_MS = 6_000
/** How long after the tick's start the job-retry drain may start a retry (safeinsights/sssb#135). */
export const RETRIES_WINDOW_MS = 10_000
/** How long after the tick's start the deliveries drain may start a delivery. */
export const DELIVERIES_WINDOW_MS = 16_000

/**
 * The share of a bounded drain's window, from the moment it starts to its deadline, in which it may list tenants: half.
 * Listing every tenant before running any row (one `withTenant` each, even a tenant with nothing due) could otherwise
 * spend the whole window once there are enough tenants, and the drain would start nothing, every tick. The other half
 * is for running. A stopgap that keeps a drain making progress: listing only the tenants with work due is the fix that
 * removes the per-tenant cost (safeinsights/sssb#202).
 */
const LISTING_SHARE = 0.5

/** No bound: what a drain called without a budget does (every due row, as before the bound). */
const UNBOUNDED: DrainBudget = { maxItems: Number.POSITIVE_INFINITY, deadline: Number.POSITIVE_INFINITY }

/** The caller's budget, checked, or no bound when it passes none. */
export function resolveDrainBudget(budget: DrainBudget | undefined): DrainBudget {
    const resolved = budget ?? UNBOUNDED
    const { maxItems, deadline } = resolved
    if (!(maxItems === Number.POSITIVE_INFINITY || (Number.isInteger(maxItems) && maxItems >= 1))) {
        throw new RangeError(`a drain budget's maxItems must be a whole number, at least 1 (got ${maxItems})`)
    }
    if (Number.isNaN(deadline) || deadline === Number.NEGATIVE_INFINITY) {
        throw new RangeError(`a drain budget's deadline must be an instant or Infinity (got ${deadline})`)
    }
    return resolved
}

/** How many rows to list per tenant: one more than the bound, or all of them when there is none. */
export function listingLimit(budget: DrainBudget): number | null {
    return Number.isFinite(budget.maxItems) ? budget.maxItems + 1 : null
}

/** Whether the deadline has not passed yet. */
export function beforeDeadline(budget: DrainBudget): boolean {
    return (budget.clock ?? Date.now)() < budget.deadline
}

/**
 * `items` in a uniformly random order (Fisher–Yates, drawing from `budget.random`), starting from id order so a given
 * sequence of draws always gives the same order. Every order is equally likely, so no item's chance of coming first
 * depends on its neighbours, idle tenants included.
 */
export function shuffled<T>(items: readonly T[], budget: DrainBudget, idOf: (item: T) => string): T[] {
    const random = budget.random ?? Math.random
    const out = [...items].sort((a, b) => (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0))
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.min(i, Math.max(0, Math.floor(random() * (i + 1))))
        const swap = out[i]!
        out[i] = out[j]!
        out[j] = swap
    }
    return out
}

/**
 * Lists each tenant's due rows, the tenants in a random order, stopping once `LISTING_SHARE` of the window has passed
 * (`listOne` runs one tenant's query; `rowKey` is a row's id), shuffles each tenant's rows, then runs `run` over them
 * round-robin until the rows or the budget run out. `run` isolates its own failures (each drain counts them); one that
 * throws anyway stops the drain, as an unhandled error did before.
 */
export async function drainFairly<T>(
    tenants: readonly { id: string }[],
    budget: DrainBudget,
    listOne: (tenantId: string) => Promise<readonly T[]>,
    rowKey: (row: T) => string,
    run: (row: T, tenantId: string) => Promise<void>,
): Promise<DrainLeft> {
    const queues: TenantQueue<T>[] = []
    const bounded = Number.isFinite(budget.maxItems) || Number.isFinite(budget.deadline)
    const clock = budget.clock ?? Date.now
    const startedAt = clock()
    // Listing stops part of the way to the deadline, so running always gets the rest of the window.
    const listUntil = Number.isFinite(budget.deadline)
        ? startedAt + (budget.deadline - startedAt) * LISTING_SHARE
        : budget.deadline
    let cutShort = false
    for (const tenant of shuffled(tenants, budget, (t) => t.id)) {
        if (clock() >= listUntil) {
            cutShort = true
            break
        }
        const rows = await listOne(tenant.id)
        // Under a bound a tenant's own rows are shuffled too, so one that fails every time without advancing (and so is
        // listed first every tick, being the oldest) does not take that tenant's turn tick after tick. With no bound
        // every row runs, so they keep their oldest-first order.
        if (rows.length > 0) queues.push({ tenantId: tenant.id, rows: bounded ? shuffled(rows, budget, rowKey) : rows })
    }
    const left = await runRoundRobin(queues, budget, run)
    // A listing its deadline cut short left tenants unlisted: say so even when every listed row was started.
    return cutShort && left.stoppedBy === null ? { ...left, stoppedBy: 'time' } : left
}

/** The turns: one row from each queue in order, round after round, until the rows or the budget run out. */
export async function runRoundRobin<T>(
    queues: readonly TenantQueue<T>[],
    budget: DrainBudget,
    run: (row: T, tenantId: string) => Promise<void>,
): Promise<DrainLeft> {
    const clock = budget.clock ?? Date.now
    const total = queues.reduce((sum, q) => sum + q.rows.length, 0)
    const rounds = queues.reduce((most, q) => Math.max(most, q.rows.length), 0)
    let started = 0
    for (let round = 0; round < rounds; round++) {
        for (const queue of queues) {
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
