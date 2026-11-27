import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { makeTestTmpDir } from '../testing/tmp-dir'
import type { ScheduleSpec } from '../core/schedules'
import type { JobsPort, SubmittedJob } from '../ports/jobs'

// Point all fake-adapter state at a throwaway dir BEFORE importing anything that touches pglite.
const tmp = makeTestTmpDir('app-schedules-db-')
beforeAll(() => {
    process.env['APP_DATA_DIR'] = tmp
})
afterAll(() => {
    delete process.env['APP_DATA_DIR']
})

/** A JobsPort that records every start() call — the scan under test spawns through this seam. */
function stubJobs(): { port: JobsPort; calls: SubmittedJob[] } {
    const calls: SubmittedJob[] = []
    return {
        port: {
            async start(job) {
                calls.push(job)
            },
        },
        calls,
    }
}

/** Count how many spawned jobs carry a given scheduleId payload — robust against the seeded schedule. */
function firedFor(calls: SubmittedJob[], scheduleId: string): number {
    return calls.filter((c) => (c.payload as { scheduleId?: string }).scheduleId === scheduleId).length
}

async function primaryOrgIds(): Promise<{ tenantId: string; orgId: string }> {
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
    return { tenantId: tenant.id, orgId: org.id }
}

async function insertSchedule(opts: { nextRunAt: Date; enabled?: boolean; spec?: ScheduleSpec }): Promise<string> {
    const { fakeDb } = await import('../adapters/fake/db')
    const { tenantId, orgId } = await primaryOrgIds()
    const spec: ScheduleSpec = opts.spec ?? { type: 'weekly', utcDay: 1, atUtcHour: 13, atUtcMinute: 0 }
    const row = await fakeDb
        .getDb()
        .insertInto('job_schedules')
        .values({
            tenant_id: tenantId,
            org_id: orgId,
            kind: 'digest-email',
            spec,
            next_run_at: opts.nextRunAt,
            enabled: opts.enabled ?? true,
            created_by: 'test',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    return row.id
}

async function nextRunAt(scheduleId: string): Promise<Date> {
    const { fakeDb } = await import('../adapters/fake/db')
    const row = await fakeDb
        .getDb()
        .selectFrom('job_schedules')
        .select('next_run_at')
        .where('id', '=', scheduleId)
        .executeTakeFirstOrThrow()
    return new Date(row.next_run_at)
}

describe('runDueSchedules', () => {
    test('spawns a job for a due schedule, advances next_run_at, and records an audit event', async () => {
        const { runDueSchedules } = await import('./schedules')
        const { fakeDb } = await import('../adapters/fake/db')
        const now = new Date('2026-07-23T14:00:00.000Z')
        const id = await insertSchedule({ nextRunAt: new Date('2026-07-23T13:00:00.000Z') })

        const jobs = stubJobs()
        const { spawned } = await runDueSchedules(fakeDb, jobs.port, now)

        expect(firedFor(jobs.calls, id)).toBe(1)
        expect(spawned).toBeGreaterThanOrEqual(1)
        // next_run_at advanced strictly past `now`.
        expect((await nextRunAt(id)).getTime()).toBeGreaterThan(now.getTime())
        // A jobs row now exists for this schedule's org, and an audit event was recorded.
        const spawnedJob = jobs.calls.find((c) => (c.payload as { scheduleId?: string }).scheduleId === id)!
        const jobRow = await fakeDb
            .getDb()
            .selectFrom('jobs')
            .select(['kind', 'status'])
            .where('id', '=', spawnedJob.id)
            .executeTakeFirst()
        expect(jobRow?.kind).toBe('digest-email')
        const audit = await fakeDb
            .getDb()
            .selectFrom('audit_events')
            .select(['action', 'subject_type'])
            .where('subject_id', '=', id)
            .executeTakeFirst()
        expect(audit).toEqual({ action: 'schedule.fired', subject_type: 'JobSchedule' })
    })

    test('is idempotent: a second scan at the same now does not double-spawn', async () => {
        const { runDueSchedules } = await import('./schedules')
        const { fakeDb } = await import('../adapters/fake/db')
        const now = new Date('2026-07-23T14:00:00.000Z')
        const id = await insertSchedule({ nextRunAt: new Date('2026-07-23T13:00:00.000Z') })

        const jobs = stubJobs()
        await runDueSchedules(fakeDb, jobs.port, now)
        await runDueSchedules(fakeDb, jobs.port, now) // second tick — row already advanced past now
        expect(firedFor(jobs.calls, id)).toBe(1)
    })

    test('coalesces missed periods: a long-overdue schedule fires once and skips to a future slot', async () => {
        const { runDueSchedules } = await import('./schedules')
        const { fakeDb } = await import('../adapters/fake/db')
        const now = new Date('2026-07-23T14:00:00.000Z')
        // Three weeks overdue — must fire ONCE, not three times, and land in the future.
        const id = await insertSchedule({ nextRunAt: new Date('2026-07-02T13:00:00.000Z') })

        const jobs = stubJobs()
        await runDueSchedules(fakeDb, jobs.port, now)
        expect(firedFor(jobs.calls, id)).toBe(1)
        expect((await nextRunAt(id)).getTime()).toBeGreaterThan(now.getTime())
    })

    test('a malformed spec fails that schedule alone: other due schedules still fire', async () => {
        const { runDueSchedules } = await import('./schedules')
        const { fakeDb } = await import('../adapters/fake/db')
        const now = new Date('2026-07-23T14:00:00.000Z')
        const bad = await insertSchedule({
            nextRunAt: new Date('2026-07-23T13:00:00.000Z'),
            spec: { type: 'bogus' } as unknown as ScheduleSpec,
        })
        const good = await insertSchedule({ nextRunAt: new Date('2026-07-23T13:30:00.000Z') })

        const jobs = stubJobs()
        const { failed } = await runDueSchedules(fakeDb, jobs.port, now)
        expect(firedFor(jobs.calls, bad)).toBe(0)
        expect(firedFor(jobs.calls, good)).toBe(1)
        expect(failed).toBeGreaterThanOrEqual(1)
        // The bad row's next_run_at never advanced — it stays due and will retry (and re-fail) next tick.
        expect((await nextRunAt(bad)).getTime()).toBeLessThanOrEqual(now.getTime())
    })

    test('skips not-due and disabled schedules', async () => {
        const { runDueSchedules } = await import('./schedules')
        const { fakeDb } = await import('../adapters/fake/db')
        const now = new Date('2026-07-23T14:00:00.000Z')
        const future = await insertSchedule({ nextRunAt: new Date('2026-07-30T13:00:00.000Z') })
        const disabled = await insertSchedule({ nextRunAt: new Date('2026-07-23T13:00:00.000Z'), enabled: false })

        const jobs = stubJobs()
        await runDueSchedules(fakeDb, jobs.port, now)
        expect(firedFor(jobs.calls, future)).toBe(0)
        expect(firedFor(jobs.calls, disabled)).toBe(0)
    })
})

describe('the schedules drain is bounded per tick and fair across tenants (safeinsights/sssb#97)', () => {
    /** A due weekly schedule on `tenantSlug`/`orgSlug`, its next run `nextRunAt`; returns its id. */
    async function scheduleOn(tenantSlug: string, orgSlug: string, nextRunAt: Date): Promise<string> {
        const { fakeDb } = await import('../adapters/fake/db')
        await fakeDb.ready()
        const tenant = await fakeDb
            .getDb()
            .selectFrom('tenants')
            .select('id')
            .where('slug', '=', tenantSlug)
            .executeTakeFirstOrThrow()
        const org = await fakeDb
            .getDb()
            .selectFrom('organizations')
            .select('id')
            .where('tenant_id', '=', tenant.id)
            .where('slug', '=', orgSlug)
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

    test("a tenant with a backlog of due schedules cannot starve another tenant's, and what it leaves fires once, later", async () => {
        const { runDueSchedules } = await import('./schedules')
        const { fakeDb } = await import('../adapters/fake/db')
        // Long before every other test's rows, so only this test's schedules are due at `now`.
        const now = new Date('2024-03-01T00:00:00.000Z')
        const busy: string[] = []
        for (let i = 0; i < 5; i++) {
            busy.push(await scheduleOn('harbor', 'annex', new Date(Date.UTC(2024, 0, 1, 0, i))))
        }
        // Due after every one of the busy tenant's, so a drain in due order would reach it last.
        const quiet = await scheduleOn('lakeside', 'wharf', new Date('2024-02-01T00:00:00.000Z'))

        const jobs = stubJobs()
        const first = await runDueSchedules(fakeDb, jobs.port, now, { maxItems: 2, deadline: Number.MAX_SAFE_INTEGER })
        expect(first).toEqual({ spawned: 2, failed: 0, deferred: 2, stoppedBy: 'items' })
        // One turn each: the quiet tenant's schedule, and one of the busy tenant's three oldest (the listing takes one
        // more than the bound, and the drain shuffles what it listed).
        expect(firedFor(jobs.calls, quiet)).toBe(1)
        const firedBusy = busy.filter((id) => firedFor(jobs.calls, id) === 1)
        expect(firedBusy).toHaveLength(1)
        expect(busy.slice(0, 3)).toContain(firedBusy[0])
        // What it left was not touched: still due at its own slot.
        for (const id of busy.filter((b) => b !== firedBusy[0])) {
            expect(firedFor(jobs.calls, id)).toBe(0)
            expect((await nextRunAt(id)).getTime()).toBeLessThanOrEqual(now.getTime())
        }

        const second = await runDueSchedules(fakeDb, jobs.port, now, { maxItems: 2, deadline: Number.MAX_SAFE_INTEGER })
        expect(second).toEqual({ spawned: 2, failed: 0, deferred: 1, stoppedBy: 'items' })
        const third = await runDueSchedules(fakeDb, jobs.port, now, { maxItems: 2, deadline: Number.MAX_SAFE_INTEGER })
        expect(third).toEqual({ spawned: 2, failed: 0, deferred: 0, stoppedBy: null })
        for (const id of [...busy, quiet]) expect(firedFor(jobs.calls, id)).toBe(1)
    })

    test('spawns nothing after its deadline, and a drain whose deadline has passed lists nothing', async () => {
        const { runDueSchedules } = await import('./schedules')
        const { fakeDb } = await import('../adapters/fake/db')
        const now = new Date('2023-03-01T00:00:00.000Z')
        const ids = [
            await scheduleOn('harbor', 'annex', new Date('2023-01-01T00:00:00.000Z')),
            await scheduleOn('harbor', 'annex', new Date('2023-01-02T00:00:00.000Z')),
            await scheduleOn('harbor', 'annex', new Date('2023-01-03T00:00:00.000Z')),
        ]
        // Each spawn takes five seconds of the tick's clock (a job the in-process runner runs inline, say).
        let clock = 0
        const calls: SubmittedJob[] = []
        const slow: JobsPort = {
            async start(job) {
                calls.push(job)
                clock += 5_000
            },
        }
        const first = await runDueSchedules(fakeDb, slow, now, { maxItems: 100, deadline: 8_000, clock: () => clock })
        // Started at 0 and 5 seconds; at 10 the deadline had passed.
        expect(first).toEqual({ spawned: 2, failed: 0, deferred: 1, stoppedBy: 'time' })
        const unfired = ids.filter((id) => firedFor(calls, id) === 0)
        expect(unfired).toHaveLength(1)

        const none = await runDueSchedules(fakeDb, slow, now, { maxItems: 100, deadline: 0, clock: () => 0 })
        expect(none).toEqual({ spawned: 0, failed: 0, deferred: 0, stoppedBy: 'time' })
        expect(firedFor(calls, unfired[0]!)).toBe(0)
    })
})
