import { describe, expect, test } from 'vitest'
import { drainBudgetOrDefault, drainFairly, drainMayStart, type TenantQueue } from './drain-budget'

/** A queue of `count` rows for `tenantId`, due from `firstDue` one millisecond apart, ids `<tenant>-<n>`. */
function queue(tenantId: string, count: number, firstDue: number): TenantQueue<{ id: string }> {
    return {
        tenantId,
        rows: Array.from({ length: count }, (_, i) => ({ id: `${tenantId}-${i}`, due: firstDue + i })),
    }
}

/** Runs the drain and returns the ids it started, in order, with what it left. */
async function started(queues: TenantQueue<{ id: string }>[], budget: Parameters<typeof drainFairly>[1]) {
    const ids: string[] = []
    const left = await drainFairly(queues, budget, async (row) => {
        ids.push(row.id)
    })
    return { ids, left }
}

const FAR = Number.MAX_SAFE_INTEGER

describe('drainFairly', () => {
    test('takes one row from each tenant in turn, so a long backlog cannot go first', async () => {
        const { ids, left } = await started([queue('a', 4, 0), queue('b', 2, 10), queue('c', 1, 20)], {
            maxItems: 100,
            deadline: FAR,
        })
        expect(ids).toEqual(['a-0', 'b-0', 'c-0', 'a-1', 'b-1', 'a-2', 'a-3'])
        expect(left).toEqual({ deferred: 0, stoppedBy: null })
    })

    test('orders the tenants by their oldest due row, not by how they were listed', async () => {
        const { ids } = await started([queue('a', 1, 30), queue('b', 1, 10), queue('c', 1, 20)], {
            maxItems: 100,
            deadline: FAR,
        })
        expect(ids).toEqual(['b-0', 'c-0', 'a-0'])
    })

    test('stops at maxItems and says how many due rows it left', async () => {
        const { ids, left } = await started([queue('a', 50, 0), queue('b', 3, 5)], { maxItems: 4, deadline: FAR })
        expect(ids).toEqual(['a-0', 'b-0', 'a-1', 'b-1'])
        expect(left).toEqual({ deferred: 49, stoppedBy: 'items' })
    })

    test('a budget that exactly fits the due rows stops for no reason', async () => {
        const { left } = await started([queue('a', 2, 0), queue('b', 2, 5)], { maxItems: 4, deadline: FAR })
        expect(left).toEqual({ deferred: 0, stoppedBy: null })
    })

    test('starts nothing once its deadline has passed, and finishes what it started', async () => {
        // Each row takes 10 seconds of the clock: a slow endpoint.
        let now = 0
        const ids: string[] = []
        const left = await drainFairly(
            [queue('slow', 10, 0), queue('quick', 2, 1)],
            { maxItems: 100, deadline: 25_000, clock: () => now },
            async (row) => {
                ids.push(row.id)
                now += 10_000
            },
        )
        // Started at 0, 10 and 20 seconds; at 30 the deadline had passed.
        expect(ids).toEqual(['slow-0', 'quick-0', 'slow-1'])
        expect(left).toEqual({ deferred: 9, stoppedBy: 'time' })
    })

    test('the starvation case: a tenant served last in one tick is served first in the next', async () => {
        // Three tenants, one row each per tick's budget of one: oldest-due order rotates them, as the drains' rows do
        // when the served row is claimed and moves on.
        const due = new Map([
            ['a', 0],
            ['b', 1],
            ['c', 2],
        ])
        const served: string[] = []
        for (let tick = 0; tick < 3; tick++) {
            const queues = [...due].map(([tenantId, at]) => ({ tenantId, rows: [{ id: tenantId, due: at }] }))
            await drainFairly(queues, { maxItems: 1, deadline: FAR }, async (row, tenantId) => {
                served.push(row.id)
                due.set(tenantId, 1_000 + tick) // claimed: its next due row is later than the others'
            })
        }
        expect(served).toEqual(['a', 'b', 'c'])
    })

    test('ties on the oldest row go by tenant id, so the order never depends on how the tenants were listed', async () => {
        const { ids } = await started([queue('b', 1, 0), queue('a', 1, 0)], { maxItems: 100, deadline: FAR })
        expect(ids).toEqual(['a-0', 'b-0'])
    })

    test('with nothing due it reports nothing left', async () => {
        const { ids, left } = await started([queue('a', 0, 0)], { maxItems: 1, deadline: FAR })
        expect(ids).toEqual([])
        expect(left).toEqual({ deferred: 0, stoppedBy: null })
    })
})

describe('drainBudgetOrDefault and drainMayStart', () => {
    test('defaults to a bound of 100 and a deadline the window ahead', () => {
        const before = Date.now()
        const budget = drainBudgetOrDefault(undefined, 8_000)
        expect(budget.maxItems).toBe(100)
        expect(budget.deadline).toBeGreaterThanOrEqual(before + 8_000)
        expect(budget.deadline).toBeLessThanOrEqual(Date.now() + 8_000)
    })

    test('refuses a budget no drain can honour', () => {
        expect(() => drainBudgetOrDefault({ maxItems: 0, deadline: 1 }, 0)).toThrow(/maxItems must be a whole number/)
        expect(() => drainBudgetOrDefault({ maxItems: 1.5, deadline: 1 }, 0)).toThrow(/maxItems/)
        expect(() => drainBudgetOrDefault({ maxItems: 1, deadline: Number.NaN }, 0)).toThrow(
            /deadline must be a finite instant/,
        )
    })

    test('a drain may start only before its deadline', () => {
        expect(drainMayStart({ maxItems: 1, deadline: 10, clock: () => 9 })).toBe(true)
        expect(drainMayStart({ maxItems: 1, deadline: 10, clock: () => 10 })).toBe(false)
    })
})
