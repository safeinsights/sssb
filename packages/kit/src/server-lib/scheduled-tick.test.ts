import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { makeTestTmpDir } from '../testing/tmp-dir'
import type { JobsPort, SubmittedJob } from '../ports/jobs'

// The registry is the one thing `runScheduledTick` takes from '../adapters/index' (a real import trips
// server-only in a test env), so hand it the fake database and a jobs port that records what the tick spawns.
const state = vi.hoisted(() => ({
    calls: [] as SubmittedJob[],
    simulated: true,
    sweeps: [] as string[],
    startThrows: false,
    sweepBudget: undefined as unknown,
}))
vi.mock('../adapters/index', async () => {
    const { fakeDb } = await import('../adapters/fake/db')
    const jobs: JobsPort = {
        async start(job) {
            if (state.startThrows) throw new Error('the runner refused it')
            state.sweeps.push('start')
            state.calls.push(job)
        },
        async sweep(_now, budget) {
            state.sweeps.push('sweep')
            state.sweepBudget = budget
            return 0
        },
    }
    const { fakeAuth } = await import('../adapters/fake/auth')
    const { fakeEmail } = await import('../adapters/fake/email')
    return {
        db: fakeDb,
        jobs,
        auth: fakeAuth,
        email: fakeEmail,
        get isSimulated() {
            return state.simulated
        },
    }
})

const tmp = makeTestTmpDir('app-scheduled-tick-')
beforeAll(() => {
    process.env['APP_DATA_DIR'] = tmp
})
afterAll(() => {
    delete process.env['APP_DATA_DIR']
})
afterEach(async () => {
    state.calls.length = 0
    state.sweeps.length = 0
    state.simulated = true
    state.startThrows = false
    const { resetClock } = await import('../adapters/fake/clock')
    resetClock()
})

const DAY_MS = 86_400_000

/** A schedule on the fixture's harbor/depot org whose next run is `nextRunAt`; returns its id. */
async function insertSchedule(nextRunAt: Date): Promise<string> {
    const { fakeDb } = await import('../adapters/fake/db')
    await fakeDb.ready()
    const tenant = await fakeDb
        .getDb()
        .selectFrom('tenants')
        .select('id')
        .where('slug', '=', 'harbor')
        .executeTakeFirstOrThrow()
    const org = await fakeDb
        .getDb()
        .selectFrom('organizations')
        .select('id')
        .where('tenant_id', '=', tenant.id)
        .where('slug', '=', 'depot')
        .executeTakeFirstOrThrow()
    const row = await fakeDb
        .getDb()
        .insertInto('job_schedules')
        .values({
            tenant_id: tenant.id,
            org_id: org.id,
            kind: 'digest-email',
            spec: { type: 'weekly', utcDay: 1, atUtcHour: 13, atUtcMinute: 0 },
            next_run_at: nextRunAt,
            enabled: true,
            created_by: 'test',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    return row.id
}

const firedFor = (scheduleId: string) =>
    state.calls.filter((call) => (call.payload as { scheduleId?: string }).scheduleId === scheduleId).length

describe('runScheduledTick', () => {
    test('spawns the job of a schedule that is due, once, and says how many it spawned', async () => {
        const { runScheduledTick } = await import('./scheduled-tick')
        const id = await insertSchedule(new Date(Date.now() - 60_000))

        const first = await runScheduledTick()
        const second = await runScheduledTick() // the row advanced past now in the first tick

        expect(first.spawned).toBeGreaterThanOrEqual(1)
        expect(first.failed).toBe(0)
        expect(firedFor(id)).toBe(1)
        expect(second.spawned).toBe(0)
        expect(firedFor(id)).toBe(1)
    })

    test('leaves a schedule that is not yet due alone', async () => {
        const { runScheduledTick } = await import('./scheduled-tick')
        const id = await insertSchedule(new Date(Date.now() + 2 * DAY_MS))

        await runScheduledTick()

        expect(firedFor(id)).toBe(0)
    })

    test("in a simulated world it ticks on the Simulator's world clock, so advancing the clock fires the schedule", async () => {
        const { runScheduledTick } = await import('./scheduled-tick')
        const { advanceClockMs } = await import('../adapters/fake/clock')
        const id = await insertSchedule(new Date(Date.now() + 2 * DAY_MS))

        await runScheduledTick()
        expect(firedFor(id), 'not due in real time').toBe(0)

        advanceClockMs(3 * DAY_MS)
        await runScheduledTick()
        expect(firedFor(id), 'due once the world clock is three days on').toBe(1)
    })

    test('in a real build it ticks on REAL time, whatever a world clock says (the clock is a simulated-world thing)', async () => {
        const { runScheduledTick } = await import('./scheduled-tick')
        const { advanceClockMs } = await import('../adapters/fake/clock')
        const id = await insertSchedule(new Date(Date.now() + 2 * DAY_MS))
        state.simulated = false
        advanceClockMs(3 * DAY_MS) // a stray offset file: three days on in world time, nothing in real time

        await runScheduledTick()

        expect(firedFor(id), 'due only in world time, so a real tick must leave it').toBe(0)
    })

    test("sweeps the jobs port's lost jobs, when it has a sweep, before it spawns anything", async () => {
        const { runScheduledTick } = await import('./scheduled-tick')
        await insertSchedule(new Date(Date.now() - DAY_MS))
        await runScheduledTick()
        expect(state.sweeps[0]).toBe('sweep')
        expect(state.sweeps.filter((call) => call === 'start').length).toBeGreaterThan(0)
    })

    test('spawns no more schedules than its bound, and the next tick spawns the rest (safeinsights/sssb#97)', async () => {
        const { runScheduledTick } = await import('./scheduled-tick')
        const ids = [
            await insertSchedule(new Date(Date.now() - 2 * 60_000)),
            await insertSchedule(new Date(Date.now() - 60_000)),
        ]

        const first = await runScheduledTick({ budget: { maxSchedules: 1 } })
        expect(first).toMatchObject({ spawned: 1, failed: 0, stoppedBy: 'items' })
        expect(first.deferred).toBeGreaterThanOrEqual(1)
        expect(ids.map(firedFor).sort()).toEqual([0, 1])

        const second = await runScheduledTick({ budget: { maxSchedules: 1 } })
        expect(second).toMatchObject({ spawned: 1, deferred: 0, stoppedBy: null })
        expect(ids.map(firedFor)).toEqual([1, 1])
    })

    test("measures each drain's window from the tick's start, and a spent schedules window leaves the deliveries theirs", async () => {
        const { runScheduledTick } = await import('./scheduled-tick')
        const id = await insertSchedule(new Date(Date.now() - 60_000))
        // The tick starts at 0 and every later reading is 5 seconds: past a 4-second schedules window, inside the
        // default deliveries one.
        let readings = 0
        const clock = () => (readings++ === 0 ? 0 : 5_000)

        const result = await runScheduledTick({ budget: { schedulesWindowMs: 4_000 }, clock })
        expect(result).toMatchObject({ spawned: 0, deferred: 0, stoppedBy: 'time' })
        expect(result.deliveries.stoppedBy).not.toBe('time')
        expect(firedFor(id)).toBe(0)

        await runScheduledTick()
        expect(firedFor(id), 'still due, so the next tick spawns it').toBe(1)
    })

    test("measures the deliveries window from the tick's start, not from where the deliveries drain begins", async () => {
        const { runScheduledTick } = await import('./scheduled-tick')
        // The tick starts at 0 and every later reading is 5 seconds: past a 4-second deliveries window counted from the
        // tick's start, though the deliveries drain itself begins at 5.
        let readings = 0
        const clock = () => (readings++ === 0 ? 0 : 5_000)

        const result = await runScheduledTick({ budget: { deliveriesWindowMs: 4_000 }, clock })
        expect(result.deliveries).toMatchObject({ delivered: 0, failed: 0, dead: 0, stoppedBy: 'time' })
    })

    test('a budget field given as undefined means its default, not a broken tick', async () => {
        const { runScheduledTick } = await import('./scheduled-tick')
        const id = await insertSchedule(new Date(Date.now() - 60_000))
        const unset: number | undefined = undefined
        const result = await runScheduledTick({ budget: { maxSchedules: unset, deliveriesWindowMs: unset } })
        expect(result.failed).toBe(0)
        expect(firedFor(id)).toBe(1)
    })

    test("notifies a job's end when its last retry could not be started (safeinsights/sssb#135)", async () => {
        const { runScheduledTick } = await import('./scheduled-tick')
        const { fakeDb } = await import('../adapters/fake/db')
        const { recordJobStatus, submitJob } = await import('../db/jobs')
        const tenant = await fakeDb
            .getDb()
            .selectFrom('tenants')
            .select('id')
            .where('slug', '=', 'harbor')
            .executeTakeFirstOrThrow()
        const org = await fakeDb
            .getDb()
            .selectFrom('organizations')
            .select('id')
            .where('tenant_id', '=', tenant.id)
            .where('slug', '=', 'depot')
            .executeTakeFirstOrThrow()
        // Attempts 1 and 2 failed an hour ago, so attempt 3 (the last) is due now.
        const past = new Date(Date.now() - 3_600_000)
        const { id } = await submitJob(
            fakeDb,
            { start: async () => undefined },
            { tenantId: tenant.id, orgId: org.id, kind: 'flaky-dockets', payload: {} },
        )
        const second = await recordJobStatus(fakeDb, tenant.id, id, 'failed', { error: 'one', now: past })
        const third = await recordJobStatus(fakeDb, tenant.id, second.retry!.jobId, 'failed', {
            error: 'two',
            now: past,
        })
        state.startThrows = true

        const result = await runScheduledTick()

        expect(result.retries).toMatchObject({ failed: 1 })
        const notified = await fakeDb
            .getDb()
            .selectFrom('notifications')
            .select('payload')
            .where('kind', '=', 'job.completed')
            .execute()
        expect(notified.map((n) => n.payload)).toContainEqual(
            expect.objectContaining({ jobId: third.retry!.jobId, status: 'failed', attempts: 3 }),
        )
    })

    test("gives the jobs port's sweep a budget of its own: a hundred jobs, and the tick's first two seconds (#252)", async () => {
        const { runScheduledTick } = await import('./scheduled-tick')
        let readings = 0
        await runScheduledTick({ clock: () => (readings++ === 0 ? 1_000 : 1_000) })
        expect(state.sweepBudget).toMatchObject({ maxItems: 100, deadline: 3_000 })
        await runScheduledTick({ budget: { maxSweep: 5, sweepWindowMs: 500 }, clock: () => 0 })
        expect(state.sweepBudget).toMatchObject({ maxItems: 5, deadline: 500 })
    })

    test("refuses a malformed sweep budget, as it does a drain's, rather than unbounding or stopping the sweep (#252)", async () => {
        const { runScheduledTick } = await import('./scheduled-tick')
        state.sweepBudget = undefined
        await expect(runScheduledTick({ budget: { maxSweep: Number.NaN } })).rejects.toThrow(RangeError)
        await expect(runScheduledTick({ budget: { maxSweep: 0 } })).rejects.toThrow(RangeError)
        await expect(runScheduledTick({ budget: { sweepWindowMs: Number.NaN } })).rejects.toThrow(RangeError)
        expect(state.sweepBudget, 'no sweep ran').toBeUndefined()
    })

    test('reports the outbound-delivery drain beside the schedules', async () => {
        const { runScheduledTick } = await import('./scheduled-tick')
        const result = await runScheduledTick()
        expect(result.deliveries).toEqual({
            delivered: expect.any(Number),
            failed: expect.any(Number),
            dead: expect.any(Number),
            deferred: expect.any(Number),
            stoppedBy: null,
        })
    })
})
