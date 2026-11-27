import { describe, expect, test } from 'vitest'
import {
    beforeDeadline,
    drainFairly,
    listingLimit,
    resolveDrainBudget,
    runRoundRobin,
    type TenantQueue,
    tickOrder,
} from './drain-budget'

/** A queue of `count` rows for `tenantId`, ids `<tenant>-<n>`. */
function queue(tenantId: string, count: number): TenantQueue<string> {
    return { tenantId, rows: Array.from({ length: count }, (_, i) => `${tenantId}-${i}`) }
}

/** Runs the turns and returns the rows started, in order, with what was left. */
async function started(queues: TenantQueue<string>[], budget: Parameters<typeof runRoundRobin>[1]) {
    const rows: string[] = []
    const left = await runRoundRobin(queues, budget, async (row) => {
        rows.push(row)
    })
    return { rows, left }
}

/** A seeded generator in [0, 1) (mulberry32), so a run of ticks is the same on every machine. */
function seeded(seed: number): () => number {
    let a = seed >>> 0
    return () => {
        a = (a + 0x6d2b79f5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

const NONE = Number.POSITIVE_INFINITY

describe('runRoundRobin', () => {
    test('takes one row from each tenant in turn, so a long backlog cannot go first', async () => {
        const { rows, left } = await started([queue('a', 4), queue('b', 2), queue('c', 1)], {
            maxItems: NONE,
            deadline: NONE,
        })
        expect(rows).toEqual(['a-0', 'b-0', 'c-0', 'a-1', 'b-1', 'a-2', 'a-3'])
        expect(left).toEqual({ deferred: 0, stoppedBy: null })
    })

    test('stops at maxItems and says how many listed rows it left', async () => {
        const { rows, left } = await started([queue('a', 50), queue('b', 3)], { maxItems: 4, deadline: NONE })
        expect(rows).toEqual(['a-0', 'b-0', 'a-1', 'b-1'])
        expect(left).toEqual({ deferred: 49, stoppedBy: 'items' })
    })

    test('a budget that exactly fits the rows stops for no reason', async () => {
        const { left } = await started([queue('a', 2), queue('b', 2)], { maxItems: 4, deadline: NONE })
        expect(left).toEqual({ deferred: 0, stoppedBy: null })
    })

    test('starts nothing once its deadline has passed, and finishes what it started', async () => {
        // Each row takes 10 seconds of the clock: a slow endpoint.
        let now = 0
        const rows: string[] = []
        const left = await runRoundRobin(
            [queue('slow', 10), queue('quick', 2)],
            { maxItems: NONE, deadline: 25_000, clock: () => now },
            async (row) => {
                rows.push(row)
                now += 10_000
            },
        )
        // Started at 0, 10 and 20 seconds; at 30 the deadline had passed.
        expect(rows).toEqual(['slow-0', 'quick-0', 'slow-1'])
        expect(left).toEqual({ deferred: 9, stoppedBy: 'time' })
    })

    test('with nothing due it reports nothing left', async () => {
        expect(await started([], { maxItems: 1, deadline: NONE })).toEqual({
            rows: [],
            left: { deferred: 0, stoppedBy: null },
        })
    })
})

describe('tickOrder', () => {
    const tenants = [{ id: 'c' }, { id: 'a' }, { id: 'd' }, { id: 'b' }]
    const order = (draw: number) =>
        tickOrder(tenants, { maxItems: 1, deadline: NONE, random: () => draw }).map((t) => t.id)

    test('is id order rotated to start where the draw lands, never the order the tenants were listed in', () => {
        expect(order(0)).toEqual(['a', 'b', 'c', 'd'])
        expect(order(0.5)).toEqual(['c', 'd', 'a', 'b'])
        expect(order(0.99)).toEqual(['d', 'a', 'b', 'c'])
        // A generator that returns 1 (outside its contract) still lands on the last tenant, not past it.
        expect(order(1)).toEqual(['d', 'a', 'b', 'c'])
        expect(tickOrder([], { maxItems: 1, deadline: NONE })).toEqual([])
    })
})

describe('drainFairly', () => {
    test('lists the tenants in the tick order and stops listing once the deadline passes', async () => {
        let now = 0
        const listed: string[] = []
        const ran: string[] = []
        const left = await drainFairly(
            [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
            { maxItems: NONE, deadline: 2, clock: () => now, random: () => 0 },
            async (tenantId) => {
                listed.push(tenantId)
                now += 1 // each listing query takes a tick of the clock
                return [`${tenantId}-0`]
            },
            async (row) => {
                ran.push(row)
            },
        )
        // `a` listed at 0, `b` at 1; at 2 the deadline had passed, so `c` was never queried and nothing started.
        expect(listed).toEqual(['a', 'b'])
        expect(ran).toEqual([])
        expect(left).toEqual({ deferred: 2, stoppedBy: 'time' })
    })

    test('a listing the deadline cut short reports the stop even when it started nothing because nothing was listed', async () => {
        const left = await drainFairly(
            [{ id: 'a' }],
            { maxItems: NONE, deadline: 0, clock: () => 0 },
            async () => {
                throw new Error('listed after the deadline')
            },
            async () => undefined,
        )
        expect(left).toEqual({ deferred: 0, stoppedBy: 'time' })
    })

    test('the starvation case: tenants with long backlogs do not keep a tenant out, tick after tick', async () => {
        // The case oldest-due ordering lost: two tenants with backlogs a thousand rows deep and older than a third
        // tenant's, and ticks with room for two turns. Served rows are claimed and leave the queue; the rest stay.
        const backlog: Record<string, number> = { a: 1000, b: 1000, c: 1000 }
        const served: Record<string, number> = { a: 0, b: 0, c: 0 }
        const random = seeded(97)
        const TICKS = 60
        for (let tick = 0; tick < TICKS; tick++) {
            await drainFairly(
                Object.keys(backlog).map((id) => ({ id })),
                { maxItems: 2, deadline: NONE, random },
                async (tenantId) => Array.from({ length: Math.min(3, backlog[tenantId]!) }, () => tenantId),
                async (_row, tenantId) => {
                    served[tenantId]! += 1
                    backlog[tenantId]! -= 1
                },
            )
        }
        // Each tenant has a two-in-three chance of a turn each tick: about 40 of 60. Far from starving.
        for (const tenant of ['a', 'b', 'c']) expect(served[tenant]).toBeGreaterThanOrEqual(25)
    })

    test("rows that fail and never advance cannot keep a healthy tenant's row out of every tick", async () => {
        // A hundred tenants each hold a row that fails every time and stays due (a schedule whose spec no longer
        // parses); one more tenant holds a healthy row. Each tick has room for a hundred turns.
        const tenants = [
            ...Array.from({ length: 100 }, (_, i) => ({ id: `stuck-${String(i).padStart(3, '0')}` })),
            { id: 'healthy' },
        ]
        let healthy = 0
        const random = seeded(135)
        for (let tick = 0; tick < 50; tick++) {
            await drainFairly(
                tenants,
                { maxItems: 100, deadline: NONE, random },
                async (tenantId) => [tenantId],
                async (_row, tenantId) => {
                    if (tenantId === 'healthy') healthy += 1
                },
            )
        }
        // A hundred chances in a hundred and one, each tick.
        expect(healthy).toBeGreaterThanOrEqual(45)
    })
})

describe('resolveDrainBudget, listingLimit and beforeDeadline', () => {
    test('no budget is no bound, which lists every row', () => {
        const budget = resolveDrainBudget(undefined)
        expect(budget).toEqual({ maxItems: NONE, deadline: NONE })
        expect(listingLimit(budget)).toBeNull()
        expect(beforeDeadline(budget)).toBe(true)
    })

    test('a bound lists one row more than it may start, per tenant', () => {
        expect(listingLimit(resolveDrainBudget({ maxItems: 100, deadline: 0 }))).toBe(101)
    })

    test('refuses a budget no drain can honour', () => {
        expect(() => resolveDrainBudget({ maxItems: 0, deadline: 1 })).toThrow(/maxItems must be a whole number/)
        expect(() => resolveDrainBudget({ maxItems: 1.5, deadline: 1 })).toThrow(/maxItems/)
        expect(() => resolveDrainBudget({ maxItems: Number.NaN, deadline: 1 })).toThrow(/maxItems/)
        expect(() => resolveDrainBudget({ maxItems: 1, deadline: Number.NaN })).toThrow(/deadline must be an instant/)
        expect(() => resolveDrainBudget({ maxItems: 1, deadline: Number.NEGATIVE_INFINITY })).toThrow(/deadline/)
    })

    test('a drain may start only before its deadline', () => {
        expect(beforeDeadline({ maxItems: 1, deadline: 10, clock: () => 9 })).toBe(true)
        expect(beforeDeadline({ maxItems: 1, deadline: 10, clock: () => 10 })).toBe(false)
    })
})
