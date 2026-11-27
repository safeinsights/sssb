import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { makeTestTmpDir } from '../testing/tmp-dir'
import type { ScheduleSpec } from '../core/schedules'
import type { DbPort } from '../ports/db'
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
        // The bad row's next_run_at never advanced: its spec cannot parse, so it was turned off rather than backed off.
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

describe('a schedule whose spawn keeps failing (safeinsights/sssb#215)', () => {
    /**
     * The fake database, but an insert into `jobs` for one of `failing.ids`' schedules (or any, with `failing.all`)
     * throws: a spawn that fails inside its transaction.
     */
    const failing = { all: false, ids: new Set<string>() }
    async function failingInserts(): Promise<DbPort> {
        const { fakeDb } = await import('../adapters/fake/db')
        const fails = (values: unknown) => {
            const scheduleId = (values as { payload?: { scheduleId?: string } }).payload?.scheduleId
            return failing.all || (scheduleId !== undefined && failing.ids.has(scheduleId))
        }
        return Object.create(fakeDb, {
            withTenant: {
                value: (tenantId: string, fn: (trx: unknown) => Promise<unknown>) =>
                    fakeDb.withTenant(tenantId, (trx) =>
                        fn(
                            new Proxy(trx, {
                                get(target, prop, receiver) {
                                    if (prop === 'insertInto') {
                                        return (table: string) => {
                                            const builder = target.insertInto(table as never)
                                            if (table !== 'jobs') return builder
                                            return new Proxy(builder, {
                                                get(b, p, r) {
                                                    if (p === 'values') {
                                                        return (values: unknown) => {
                                                            if (fails(values))
                                                                throw new Error('fixture: the jobs insert failed')
                                                            return b.values(values as never)
                                                        }
                                                    }
                                                    const v = Reflect.get(b, p, r)
                                                    return typeof v === 'function' ? v.bind(b) : v
                                                },
                                            })
                                        }
                                    }
                                    const value = Reflect.get(target, prop, receiver)
                                    return typeof value === 'function' ? value.bind(target) : value
                                },
                            }),
                        ),
                    ),
            },
        }) as DbPort
    }

    async function scheduleRow(id: string) {
        const { fakeDb } = await import('../adapters/fake/db')
        return fakeDb
            .getDb()
            .selectFrom('job_schedules')
            .select(['enabled', 'next_run_at', 'failure_count', 'last_error'])
            .where('id', '=', id)
            .executeTakeFirstOrThrow()
    }

    test('a spec that no longer parses turns the schedule off at its first failure, and an audit event says why', async () => {
        const { runDueSchedules } = await import('./schedules')
        const { fakeDb } = await import('../adapters/fake/db')
        const now = new Date('2022-03-01T00:00:00.000Z')
        const id = await insertSchedule({
            nextRunAt: new Date('2022-02-01T00:00:00.000Z'),
            spec: { type: 'bogus' } as unknown as ScheduleSpec,
        })
        const jobs = stubJobs()
        expect(await runDueSchedules(fakeDb, jobs.port, now)).toMatchObject({ failed: 1 })
        expect(await scheduleRow(id)).toMatchObject({ enabled: false, failure_count: 1 })
        expect((await scheduleRow(id)).last_error).toMatch(/schedule spec|bogus|type/i)
        const audit = await fakeDb
            .getDb()
            .selectFrom('audit_events')
            .select(['action', 'detail'])
            .where('subject_id', '=', id)
            .where('action', '=', 'schedule.disabled')
            .executeTakeFirstOrThrow()
        expect(audit.detail).toMatchObject({ reason: 'spec does not parse' })
        // Off, so no later tick lists it.
        expect(await runDueSchedules(fakeDb, jobs.port, new Date(now.getTime() + 86_400_000))).toMatchObject({
            failed: 0,
        })
    })

    test('any other failure backs off, longer each time, and the next spawn that commits clears it', async () => {
        const { runDueSchedules } = await import('./schedules')
        const db = await failingInserts()
        const now = new Date('2021-03-01T00:00:00.000Z')
        const id = await insertSchedule({ nextRunAt: new Date('2021-03-01T00:00:00.000Z') })
        const jobs = stubJobs()

        failing.all = true
        try {
            expect(await runDueSchedules(db, jobs.port, now)).toMatchObject({ failed: 1 })
            let row = await scheduleRow(id)
            expect(row).toMatchObject({
                enabled: true,
                failure_count: 1,
                last_error: 'fixture: the jobs insert failed',
            })
            expect(new Date(row.next_run_at).getTime()).toBe(now.getTime() + 60_000)
            // Not due again until its backoff has passed; then it fails again, and waits five minutes.
            expect(await runDueSchedules(db, jobs.port, new Date(now.getTime() + 30_000))).toMatchObject({ failed: 0 })
            const second = new Date(now.getTime() + 61_000)
            expect(await runDueSchedules(db, jobs.port, second)).toMatchObject({ failed: 1 })
            row = await scheduleRow(id)
            expect(row.failure_count).toBe(2)
            expect(new Date(row.next_run_at).getTime()).toBe(second.getTime() + 5 * 60_000)
        } finally {
            failing.all = false
        }

        const recovered = new Date(now.getTime() + 61_000 + 5 * 60_000 + 1_000)
        expect(await runDueSchedules(db, jobs.port, recovered)).toMatchObject({ spawned: 1, failed: 0 })
        expect(await scheduleRow(id)).toMatchObject({ enabled: true, failure_count: 0, last_error: null })
        expect(firedFor(jobs.calls, id)).toBe(1)
    })

    test.each([
        ['turned off', { type: 'bogus' } as unknown as ScheduleSpec, false],
        ['backed off', undefined, true],
    ])(
        'a healthy schedule still spawns beside more %s schedules than the per-tenant listing takes',
        async (_how, spec, viaInserts) => {
            const { runDueSchedules } = await import('./schedules')
            const { fakeDb } = await import('../adapters/fake/db')
            const db = viaInserts ? await failingInserts() : fakeDb
            const year = viaInserts ? 2019 : 2018
            const now = new Date(Date.UTC(year, 5, 1))
            // Five stuck schedules, all due before the healthy one; the listing takes maxItems + 1 = 3 a tenant.
            const stuck: string[] = []
            for (let i = 0; i < 5; i++) {
                stuck.push(
                    await insertSchedule({ nextRunAt: new Date(Date.UTC(year, 0, 1, 0, i)), ...(spec && { spec }) }),
                )
            }
            const healthy = await insertSchedule({ nextRunAt: new Date(Date.UTC(year, 1, 1)) })
            const jobs = stubJobs()
            const budget = { maxItems: 2, deadline: Number.MAX_SAFE_INTEGER }
            for (const id of stuck) failing.ids.add(id)
            let ticks = 0
            try {
                while (firedFor(jobs.calls, healthy) === 0 && ticks < 5) {
                    ticks += 1
                    await runDueSchedules(db, jobs.port, new Date(now.getTime() + ticks * 1_000), budget)
                }
            } finally {
                failing.ids.clear()
            }
            expect(firedFor(jobs.calls, healthy)).toBe(1)
            // Two turns a tick: the five stuck ones are turned or backed off within three ticks, and none comes back
            // (the first backoff is a minute), so the healthy one is reached by the fourth.
            expect(ticks).toBeLessThanOrEqual(4)
            for (const id of stuck) expect((await scheduleRow(id)).failure_count).toBeLessThanOrEqual(1)
        },
    )

    test('a failure after the spawn committed (the runner refused the job) is not a spawn failure', async () => {
        const { runDueSchedules } = await import('./schedules')
        const { fakeDb } = await import('../adapters/fake/db')
        const now = new Date('2017-03-01T00:00:00.000Z')
        const id = await insertSchedule({ nextRunAt: new Date('2017-02-01T00:00:00.000Z') })
        const refusing: JobsPort = {
            async start() {
                throw new Error('runner down')
            },
        }
        expect(await runDueSchedules(fakeDb, refusing, now)).toMatchObject({ failed: 1 })
        const row = await scheduleRow(id)
        expect(row).toMatchObject({ enabled: true, failure_count: 0, last_error: null })
        expect(new Date(row.next_run_at).getTime()).toBeGreaterThan(now.getTime())
    })
})
