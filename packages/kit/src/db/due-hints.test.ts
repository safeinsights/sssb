import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { makeTestTmpDir } from '../testing/tmp-dir'
import type { JobsPort, SubmittedJob } from '../ports/jobs'

const tmp = makeTestTmpDir('app-due-hints-')
beforeAll(async () => {
    process.env['APP_DATA_DIR'] = tmp
    await world()
}, 120_000)
afterAll(() => {
    delete process.env['APP_DATA_DIR']
})
// Each test starts with no due work and no hints: what an earlier one left (schedules dated before a later test's
// `now`, open deliveries, waiting retries) would otherwise be due in the next.
beforeEach(async () => {
    const { fakeDb } = await world()
    const raw = fakeDb.getDb()
    await raw.updateTable('job_schedules').set({ enabled: false }).execute()
    await raw
        .updateTable('webhook_deliveries')
        .set({ status: 'dead' })
        .where('status', 'in', ['pending', 'failed'])
        .execute()
    await raw.updateTable('jobs').set({ status: 'failed', run_after: null }).where('status', '=', 'queued').execute()
    await raw.deleteFrom('due_hint_events').execute()
    await raw.deleteFrom('due_hints').execute()
})

/**
 * Due hints (safeinsights/sssb#202, migration 0022_due_hints): the tick's drains list only the tenants whose hint, or
 * an event, has come. Triggers append an event on every write that can make work due; a drain sets the hints of the
 * tenants it listed, and deletes the events their listing accounted for, by compare-and-set. Driven here on the fake
 * database, through the drains as the tick calls them. What waits on what needs real Postgres
 * (../adapters/real/db.contract.test.ts).
 */

const HINTED = { maxItems: 100, deadline: Number.MAX_SAFE_INTEGER, dueHints: true } as const
const MINUTE = 60_000

async function world() {
    const { fakeDb } = await import('../adapters/fake/db')
    await fakeDb.ready()
    const tenant = await fakeDb
        .getDb()
        .selectFrom('tenants')
        .select('id')
        .where('slug', '=', 'harbor')
        .executeTakeFirstOrThrow()
    const other = await fakeDb
        .getDb()
        .selectFrom('tenants')
        .select('id')
        .where('slug', '=', 'lakeside')
        .executeTakeFirstOrThrow()
    const org = await fakeDb
        .getDb()
        .selectFrom('organizations')
        .select('id')
        .where('tenant_id', '=', tenant.id)
        .where('slug', '=', 'depot')
        .executeTakeFirstOrThrow()
    return { fakeDb, tenantId: tenant.id, otherTenantId: other.id, orgId: org.id }
}

async function hint(tenantId: string, drain: 'schedules' | 'retries' | 'deliveries') {
    const { fakeDb } = await world()
    return fakeDb
        .getDb()
        .selectFrom('due_hints')
        .select(['list_after', 'version'])
        .where('tenant_id', '=', tenantId)
        .where('drain', '=', drain)
        .executeTakeFirst()
}

/** The due times of the tenant's events for `drain`, earliest first. */
async function events(tenantId: string, drain: 'schedules' | 'retries' | 'deliveries') {
    const { fakeDb } = await world()
    const rows = await fakeDb
        .getDb()
        .selectFrom('due_hint_events')
        .select('due')
        .where('tenant_id', '=', tenantId)
        .where('drain', '=', drain)
        .orderBy('due')
        .execute()
    return rows.map((r) => new Date(r.due as Date).getTime())
}

/** When the tick next lists the tenant for `drain`: its hint or its earliest event, whichever is sooner (null: no hint). */
async function effective(tenantId: string, drain: 'schedules' | 'retries' | 'deliveries') {
    const h = await hint(tenantId, drain)
    const e = await events(tenantId, drain)
    const times = [...(h ? [new Date(h.list_after as Date).getTime()] : []), ...e]
    return h ? Math.min(...times) : null
}

/** Every tenant a drain asks about, recorded by wrapping withTenant (each listing is one). */
async function listingCounter() {
    const { fakeDb } = await world()
    const listed: string[] = []
    const db = Object.create(fakeDb, {
        withTenant: {
            value: (tenantId: string, fn: Parameters<typeof fakeDb.withTenant>[1]) => {
                listed.push(tenantId)
                return fakeDb.withTenant(tenantId, fn)
            },
        },
    }) as typeof fakeDb
    return { db, listed }
}

const stubJobs = (): JobsPort & { calls: SubmittedJob[] } => {
    const calls: SubmittedJob[] = []
    return {
        calls,
        async start(job) {
            calls.push(job)
        },
    }
}

async function insertSchedule(tenantId: string, orgId: string, nextRunAt: Date): Promise<string> {
    const { fakeDb } = await world()
    return (
        await fakeDb
            .getDb()
            .insertInto('job_schedules')
            .values({
                tenant_id: tenantId,
                org_id: orgId,
                kind: 'digest-email',
                spec: { type: 'weekly', utcDay: 1, atUtcHour: 13, atUtcMinute: 0 },
                next_run_at: nextRunAt,
                enabled: true,
                created_by: 'test',
            })
            .returning('id')
            .executeTakeFirstOrThrow()
    ).id
}

describe('the schedules drain with due hints', () => {
    test('a write appends an event; the drain lists the tenant, sets its hint and consumes the event; later writes only lower it', async () => {
        const { tenantId, orgId } = await world()
        const { runDueSchedules } = await import('./schedules')
        // A year on, where nothing of the other tests' is due.
        const now = new Date('2031-01-05T00:00:00.000Z')
        const later = new Date(now.getTime() + 3 * 60 * MINUTE)
        const sooner = new Date(now.getTime() + 60 * MINUTE)
        await insertSchedule(tenantId, orgId, later)
        expect(await events(tenantId, 'schedules')).toEqual([later.getTime()])
        // No hint yet: the tenant is listed.
        let { db, listed } = await listingCounter()
        await runDueSchedules(db, stubJobs(), now, HINTED)
        expect(listed).toContain(tenantId)
        // Nothing due: the hint is the tenant's next due time, and the event it accounted for is gone.
        expect(new Date((await hint(tenantId, 'schedules'))!.list_after as Date).getTime()).toBe(later.getTime())
        expect(await events(tenantId, 'schedules')).toEqual([])

        // A write due sooner brings the tenant's turn forward; one due later does not put it back.
        await insertSchedule(tenantId, orgId, sooner)
        expect(await effective(tenantId, 'schedules')).toBe(sooner.getTime())
        await insertSchedule(tenantId, orgId, new Date(now.getTime() + 10 * 60 * MINUTE))
        expect(await effective(tenantId, 'schedules')).toBe(sooner.getTime())
        ;({ db, listed } = await listingCounter())
        await runDueSchedules(db, stubJobs(), new Date(now.getTime() + MINUTE), HINTED)
        expect(listed, 'neither its hint nor an event has come, so the next tick skips it').not.toContain(tenantId)

        // A schedule written due now appends an event that has come, and the next tick lists the tenant and fires it.
        const due = await insertSchedule(tenantId, orgId, new Date(now.getTime() + MINUTE))
        const jobs = stubJobs()
        ;({ db, listed } = await listingCounter())
        await runDueSchedules(db, jobs, new Date(now.getTime() + 2 * MINUTE), HINTED)
        expect(listed).toContain(tenantId)
        expect(jobs.calls.map((c) => (c.payload as { scheduleId: string }).scheduleId)).toContain(due)
    })

    test("a hint is set to the tenant's EARLIEST next due time, and at most a day on", async () => {
        const { fakeDb, tenantId, orgId } = await world()
        const { runDueSchedules } = await import('./schedules')
        const { MAX_SKIP_MS } = await import('./due-hints')
        const now = new Date('2036-01-05T00:00:00.000Z')
        await insertSchedule(tenantId, orgId, new Date(now.getTime() + 5 * 60 * MINUTE))
        await insertSchedule(tenantId, orgId, new Date(now.getTime() + 2 * 60 * MINUTE))
        await runDueSchedules(fakeDb, stubJobs(), now, HINTED)
        expect(new Date((await hint(tenantId, 'schedules'))!.list_after as Date).getTime()).toBe(
            now.getTime() + 2 * 60 * MINUTE,
        )
        // Only work further off than a day: the hint stops at a day.
        const far = new Date('2040-01-05T00:00:00.000Z')
        await fakeDb.getDb().updateTable('job_schedules').set({ enabled: false }).execute()
        await fakeDb.getDb().deleteFrom('due_hints').where('tenant_id', '=', tenantId).execute()
        await insertSchedule(tenantId, orgId, new Date(far.getTime() + 3 * MAX_SKIP_MS))
        await runDueSchedules(fakeDb, stubJobs(), far, HINTED)
        expect(new Date((await hint(tenantId, 'schedules'))!.list_after as Date).getTime()).toBe(
            far.getTime() + MAX_SKIP_MS,
        )
    })

    test("the tick's own advance of a schedule appends nothing; moving one earlier appends its time", async () => {
        const { fakeDb, tenantId, orgId } = await world()
        const { runDueSchedules } = await import('./schedules')
        const now = new Date('2041-01-05T00:00:00.000Z')
        const due = await insertSchedule(tenantId, orgId, new Date(now.getTime() - MINUTE))
        await fakeDb.getDb().deleteFrom('due_hint_events').execute()
        const jobs = stubJobs()
        await runDueSchedules(fakeDb, jobs, now, HINTED)
        expect(jobs.calls.map((c) => (c.payload as { scheduleId: string }).scheduleId)).toContain(due)
        // The spawn moved the schedule a week on: a later due time appends nothing.
        expect(await events(tenantId, 'schedules')).toEqual([])

        // Moving a schedule earlier by an update does append.
        const far = await insertSchedule(tenantId, orgId, new Date(now.getTime() + 30 * 24 * 60 * MINUTE))
        await fakeDb.getDb().deleteFrom('due_hint_events').execute()
        const soon = new Date(now.getTime() + 10 * MINUTE)
        await fakeDb.getDb().updateTable('job_schedules').set({ next_run_at: soon }).where('id', '=', far).execute()
        expect(await events(tenantId, 'schedules')).toEqual([soon.getTime()])
    })

    test('re-enabling a schedule appends its time, so its work is not hidden', async () => {
        const { fakeDb, tenantId, orgId } = await world()
        const { runDueSchedules } = await import('./schedules')
        const now = new Date('2037-01-05T00:00:00.000Z')
        const id = await insertSchedule(tenantId, orgId, new Date(now.getTime() - MINUTE))
        await fakeDb.getDb().updateTable('job_schedules').set({ enabled: false }).where('id', '=', id).execute()
        await fakeDb.getDb().deleteFrom('due_hint_events').execute()
        // Listed with nothing due (the schedule is off): set a day on.
        await runDueSchedules(fakeDb, stubJobs(), now, HINTED)
        expect(new Date((await hint(tenantId, 'schedules'))!.list_after as Date).getTime()).toBeGreaterThan(
            now.getTime(),
        )
        await fakeDb.getDb().updateTable('job_schedules').set({ enabled: true }).where('id', '=', id).execute()
        const jobs = stubJobs()
        await runDueSchedules(fakeDb, jobs, new Date(now.getTime() + MINUTE), HINTED)
        expect(jobs.calls.map((c) => (c.payload as { scheduleId: string }).scheduleId)).toContain(id)
    })

    test('a drain without hints lists every tenant, whatever the hints say, and sets none', async () => {
        const { fakeDb, tenantId, otherTenantId } = await world()
        const { runDueSchedules } = await import('./schedules')
        const { db, listed } = await listingCounter()
        await runDueSchedules(db, stubJobs(), new Date('2031-01-05T00:05:00.000Z'), {
            maxItems: 100,
            deadline: Number.MAX_SAFE_INTEGER,
        })
        expect(listed).toEqual(expect.arrayContaining([tenantId, otherTenantId]))
        expect(await fakeDb.getDb().selectFrom('due_hints').selectAll().execute()).toEqual([])
    })
})

describe('the deliveries and retries drains with due hints', () => {
    test('a delivery enqueued for a tenant whose hint is far off is delivered by the next tick', async () => {
        const { fakeDb, tenantId, orgId } = await world()
        const { createEndpoint, enqueueWebhookEvent, runDueDeliveries } = await import('./webhooks')
        const now = new Date('2032-01-01T00:00:00.000Z')
        // Nothing due: the drain sets the tenant's hint a day on.
        await runDueDeliveries(fakeDb, now, () => ({ delivered: true }), HINTED)
        expect(new Date((await hint(tenantId, 'deliveries'))!.list_after as Date).getTime()).toBeGreaterThan(
            now.getTime(),
        )

        await createEndpoint(fakeDb, {
            tenantId,
            orgId,
            url: 'https://hints.example.test/hook',
            eventKinds: ['job.status_changed'],
            secret: 'whsec_hints',
            createdBy: 'test',
        })
        await enqueueWebhookEvent(
            fakeDb,
            {
                tenantId,
                orgId,
                kind: 'job.status_changed',
                payload: { jobId: 'j', jobKind: 'k', status: 'completed', orgId },
            },
            new Date(now.getTime() + MINUTE),
        )
        const sent: string[] = []
        const result = await runDueDeliveries(
            fakeDb,
            new Date(now.getTime() + 2 * MINUTE),
            (input) => {
                sent.push(input.deliveryId)
                return { delivered: true }
            },
            HINTED,
        )
        expect(result.delivered).toBe(1)
        expect(sent).toHaveLength(1)
    })

    test('a retry armed for a tenant whose hint is far off appends its time, and the tick starts it when it is due', async () => {
        const { fakeDb, tenantId, orgId } = await world()
        const { recordJobStatus, runDueRetries, submitJob } = await import('./jobs')
        const now = new Date('2033-01-01T00:00:00.000Z')
        await runDueRetries(fakeDb, stubJobs(), now, HINTED)
        const { id } = await submitJob(
            fakeDb,
            { start: async () => undefined },
            { tenantId, orgId, kind: 'flaky-dockets', payload: {} },
        )
        await recordJobStatus(fakeDb, tenantId, id, 'failed', { error: 'first', now })
        expect(await effective(tenantId, 'retries')).toBeLessThanOrEqual(now.getTime() + MINUTE)
        const jobs = stubJobs()
        expect(await runDueRetries(fakeDb, jobs, new Date(now.getTime() + 2 * MINUTE), HINTED)).toMatchObject({
            started: 1,
        })
        expect(jobs.calls[0]).toMatchObject({ firstJobId: id, attempt: 2 })
    })
})

describe('work a drain leaves, and status-only moves', () => {
    test('deliveries a budget left over stay listed: the claim of the first does not hide the rest', async () => {
        const { fakeDb, otherTenantId } = await world()
        const { createEndpoint, enqueueWebhookEvent, runDueDeliveries } = await import('./webhooks')
        const org = await fakeDb
            .getDb()
            .selectFrom('organizations')
            .select('id')
            .where('tenant_id', '=', otherTenantId)
            .executeTakeFirstOrThrow()
        const now = new Date('2038-01-01T00:00:00.000Z')
        await createEndpoint(fakeDb, {
            tenantId: otherTenantId,
            orgId: org.id,
            url: 'https://backlog.example.test/hook',
            eventKinds: ['job.status_changed'],
            secret: 'whsec_backlog',
            createdBy: 'test',
        })
        for (let i = 0; i < 3; i++) {
            await enqueueWebhookEvent(
                fakeDb,
                {
                    tenantId: otherTenantId,
                    orgId: org.id,
                    kind: 'job.status_changed',
                    payload: { jobId: `b${i}`, jobKind: 'k', status: 'completed', orgId: org.id },
                },
                now,
            )
        }
        const one = { ...HINTED, maxItems: 1 }
        let delivered = 0
        for (let tick = 1; tick <= 3; tick++) {
            delivered += (
                await runDueDeliveries(fakeDb, new Date(now.getTime() + tick * 1_000), () => ({ delivered: true }), one)
            ).delivered
        }
        expect(delivered).toBe(3)
        // A tenant listed with rows had its hint set to the tick's now (listed again) and its events consumed.
        expect(await events(otherTenantId, 'deliveries')).toEqual([])
    })

    test('a delivery moved back to failed by its status alone appends its time', async () => {
        const { fakeDb, tenantId, orgId } = await world()
        const { createEndpoint, enqueueWebhookEvent, runDueDeliveries } = await import('./webhooks')
        const now = new Date('2039-01-01T00:00:00.000Z')
        await createEndpoint(fakeDb, {
            tenantId,
            orgId,
            url: 'https://status.example.test/hook',
            eventKinds: ['job.status_changed'],
            secret: 'whsec_status',
            createdBy: 'test',
        })
        await enqueueWebhookEvent(
            fakeDb,
            {
                tenantId,
                orgId,
                kind: 'job.status_changed',
                payload: { jobId: 's', jobKind: 'k', status: 'completed', orgId },
            },
            now,
        )
        // Every endpoint subscribed gets one (an earlier test's too): keep this test's, retire the others.
        const row = await fakeDb
            .getDb()
            .selectFrom('webhook_deliveries as d')
            .innerJoin('webhook_endpoints as e', 'e.id', 'd.endpoint_id')
            .select('d.id as id')
            .where('d.tenant_id', '=', tenantId)
            .where('d.next_attempt_at', '=', now)
            .where('e.url', '=', 'https://status.example.test/hook')
            .executeTakeFirstOrThrow()
        await fakeDb
            .getDb()
            .updateTable('webhook_deliveries')
            .set({ status: 'dead' })
            .where('tenant_id', '=', tenantId)
            .where('id', '!=', row.id)
            .where('status', 'in', ['pending', 'failed'])
            .execute()
        await fakeDb
            .getDb()
            .updateTable('webhook_deliveries')
            .set({ status: 'dead' })
            .where('id', '=', row.id)
            .execute()
        await runDueDeliveries(fakeDb, new Date(now.getTime() + MINUTE), () => ({ delivered: true }), HINTED)
        expect(new Date((await hint(tenantId, 'deliveries'))!.list_after as Date).getTime()).toBeGreaterThan(
            now.getTime(),
        )
        await fakeDb
            .getDb()
            .updateTable('webhook_deliveries')
            .set({ status: 'failed' })
            .where('id', '=', row.id)
            .execute()
        expect(await events(tenantId, 'deliveries')).toEqual([now.getTime()])
        const result = await runDueDeliveries(
            fakeDb,
            new Date(now.getTime() + 2 * MINUTE),
            () => ({ delivered: true }),
            HINTED,
        )
        expect(result.delivered).toBe(1)
    })
})

describe('settleHints and tenantsToList', () => {
    test('an event committed after the read stays, so its tenant is listed again; the ones the read saw go', async () => {
        const { fakeDb, tenantId, orgId } = await world()
        const { settleHints, tenantsToList } = await import('./due-hints')
        const now = new Date('2034-01-01T00:00:00.000Z')
        await insertSchedule(tenantId, orgId, new Date(now.getTime() + 30 * MINUTE)) // an event, seen by the read
        const read = await tenantsToList(fakeDb, 'schedules', now)
        const tenant = read.tenants.find((t) => t.id === tenantId)!
        // Meanwhile a write makes work due now: its event is committed after the read's snapshot.
        await insertSchedule(tenantId, orgId, new Date(now.getTime() - MINUTE))
        await settleHints(fakeDb, 'schedules', now, read, [
            { tenant, hadRows: false, nextDue: new Date(now.getTime() + 30 * MINUTE) },
        ])
        expect(new Date((await hint(tenantId, 'schedules'))!.list_after as Date).getTime()).toBe(
            now.getTime() + 30 * MINUTE,
        )
        expect(await events(tenantId, 'schedules'), 'only the later write is left').toEqual([now.getTime() - MINUTE])
        expect((await tenantsToList(fakeDb, 'schedules', now)).tenants.map((t) => t.id)).toContain(tenantId)
    })

    test('a settle from a read another tick has settled since changes nothing, and deletes none of the events', async () => {
        const { fakeDb, tenantId, orgId } = await world()
        const { settleHints, tenantsToList } = await import('./due-hints')
        const now = new Date('2034-06-01T00:00:00.000Z')
        // A hint row to compare against (each path is tried: an existing row by version, a missing one by its key).
        await fakeDb
            .getDb()
            .insertInto('due_hints')
            .values({ tenant_id: tenantId, drain: 'schedules', list_after: new Date(0), version: 3 })
            .execute()
        await insertSchedule(tenantId, orgId, new Date(now.getTime() + 30 * MINUTE))
        const stale = await tenantsToList(fakeDb, 'schedules', now)
        const fresher = await tenantsToList(fakeDb, 'schedules', now)
        const of = (read: typeof stale) => read.tenants.find((t) => t.id === tenantId)!
        // The fresher tick settles first; a second write's event arrives after both reads.
        await settleHints(fakeDb, 'schedules', now, fresher, [
            { tenant: of(fresher), hadRows: false, nextDue: new Date(now.getTime() + 30 * MINUTE) },
        ])
        await insertSchedule(tenantId, orgId, new Date(now.getTime() + 5 * MINUTE))
        await settleHints(fakeDb, 'schedules', now, stale, [
            { tenant: of(stale), hadRows: false, nextDue: new Date(now.getTime() + 60 * MINUTE) },
        ])
        expect(new Date((await hint(tenantId, 'schedules'))!.list_after as Date).getTime()).toBe(
            now.getTime() + 30 * MINUTE,
        )
        expect(await events(tenantId, 'schedules')).toEqual([now.getTime() + 5 * MINUTE])
        expect(String((await hint(tenantId, 'schedules'))!.version)).toBe('4')
    })

    test('a hint further off than a day is read as come, and unreadable hints list every tenant and set nothing', async () => {
        const { fakeDb, tenantId, otherTenantId } = await world()
        const { MAX_SKIP_MS, settleHints, tenantsToList } = await import('./due-hints')
        const now = new Date('2035-01-01T00:00:00.000Z')
        await fakeDb
            .getDb()
            .insertInto('due_hints')
            .values({
                tenant_id: tenantId,
                drain: 'schedules',
                list_after: new Date(now.getTime() + MAX_SKIP_MS + MINUTE),
            })
            .execute()
        expect((await tenantsToList(fakeDb, 'schedules', now)).tenants.map((t) => t.id)).toContain(tenantId)

        // Every statement that names the hints fails, as a missing grant would, transactions included (a plugin, which
        // they inherit); the plain tenants read works.
        const refusing = fakeDb.getDb().withPlugin({
            transformQuery: ({ node }) => {
                if (JSON.stringify(node).includes('due_hint')) throw new Error('permission denied for table due_hints')
                return node
            },
            transformResult: async ({ result }) => result,
        })
        const broken = Object.create(fakeDb, { getDb: { value: () => refusing } }) as typeof fakeDb
        const read = await tenantsToList(broken, 'schedules', now)
        expect(read.tenants.map((t) => t.id)).toEqual(expect.arrayContaining([tenantId, otherTenantId]))
        expect(read.tenants.every((t) => t.unhinted === true)).toBe(true)
        await settleHints(
            broken,
            'schedules',
            now,
            read,
            read.tenants.map((tenant) => ({ tenant, hadRows: false, nextDue: null })),
        )
    })
})

describe('a read that fails', () => {
    test('falls back to every tenant with its hint, so the drain lists everyone and still settles', async () => {
        const { fakeDb, tenantId, otherTenantId, orgId } = await world()
        const { settleHints, tenantsToList } = await import('./due-hints')
        const now = new Date('2044-01-05T00:00:00.000Z')
        await insertSchedule(tenantId, orgId, new Date(now.getTime() - MINUTE))
        // The first read of the events fails (as a timeout would); the hints-only read after it does not.
        let refused = 0
        const failingOnce = fakeDb.getDb().withPlugin({
            transformQuery: ({ node }) => {
                if (refused === 0 && JSON.stringify(node).includes('public.due_hints h')) {
                    refused += 1
                    throw new Error('canceling statement due to statement timeout')
                }
                return node
            },
            transformResult: async ({ result }) => result,
        })
        const flaky = Object.create(fakeDb, { getDb: { value: () => failingOnce } }) as typeof fakeDb
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const read = await tenantsToList(flaky, 'schedules', now)
            expect(read.tenants.map((t) => t.id)).toEqual(expect.arrayContaining([tenantId, otherTenantId]))
            expect(read.tenants.every((t) => t.unhinted === undefined)).toBe(true)
            expect(read.snapshot).not.toBeNull()
            expect(refused, 'the first read was refused, and the fallback read').toBe(1)
            await settleHints(
                fakeDb,
                'schedules',
                now,
                read,
                read.tenants.map((tenant) => ({ tenant, hadRows: tenant.id === tenantId, nextDue: null })),
            )
        } finally {
            warn.mockRestore()
        }
        expect(
            await events(tenantId, 'schedules'),
            'its events are cleared, so the next read is not slowed by them',
        ).toEqual([])
    })
})

describe('the owner reads the real tables', () => {
    test('temporary tables named like them on the same connection do not stand in', async () => {
        const { fakeDb, tenantId } = await world()
        const { sql } = await import('kysely')
        const { tenantsToList } = await import('./due-hints')
        const now = new Date()
        // The real hint says "come" (listed); temporary tables of the same names say "an hour off" (skipped).
        await fakeDb
            .getDb()
            .insertInto('due_hints')
            .values({ tenant_id: tenantId, drain: 'schedules', list_after: new Date(0), version: 7 })
            .execute()
        const raw = fakeDb.getDb()
        await sql`CREATE TEMP TABLE due_hints (tenant_id uuid, drain text, list_after timestamptz, version bigint)`.execute(
            raw,
        )
        await sql`CREATE TEMP TABLE due_hint_events (tenant_id uuid, drain text, due timestamptz, writer xid8)`.execute(
            raw,
        )
        try {
            await sql`INSERT INTO pg_temp.due_hints VALUES (${tenantId}, 'schedules', ${new Date(now.getTime() + 3_600_000)}, 1)`.execute(
                raw,
            )
            const read = await tenantsToList(fakeDb, 'schedules', now)
            expect(read.tenants.find((t) => t.id === tenantId)).toMatchObject({ hintVersion: '7' })
        } finally {
            await sql`DROP TABLE pg_temp.due_hints`.execute(raw)
            await sql`DROP TABLE pg_temp.due_hint_events`.execute(raw)
        }
    })
})

describe('what a tick leaves, whatever its clock does and however much a tenant piles up', () => {
    test("a tenant listed with rows left due is listed again after the Simulator's clock is moved back", async () => {
        const { tenantId, orgId } = await world()
        const { runDueSchedules } = await import('./schedules')
        // The review's probe: two schedules due an hour before real time; a tick twelve hours ahead (an advanced world
        // clock) runs one of them, then the clock goes back to real time.
        const real = new Date('2042-01-05T00:00:00.000Z')
        const ids = [
            await insertSchedule(tenantId, orgId, new Date(real.getTime() - 60 * MINUTE)),
            await insertSchedule(tenantId, orgId, new Date(real.getTime() - 60 * MINUTE)),
        ]
        const { fakeDb } = await world()
        const ahead = stubJobs()
        await runDueSchedules(fakeDb, ahead, new Date(real.getTime() + 12 * 60 * MINUTE), { ...HINTED, maxItems: 1 })
        expect(ahead.calls).toHaveLength(1)
        const left = ids.find((id) => id !== (ahead.calls[0]!.payload as { scheduleId: string }).scheduleId)!
        const back = stubJobs()
        const { db, listed } = await listingCounter()
        await runDueSchedules(db, back, new Date(real.getTime() + MINUTE), HINTED)
        expect(listed).toContain(tenantId)
        expect(back.calls.map((c) => (c.payload as { scheduleId: string }).scheduleId)).toContain(left)
    })

    test("a settle clears a tenant's pile a bounded statement at a time while its window lasts; a spent window sets hints only", async () => {
        const { fakeDb, tenantId } = await world()
        const { sql } = await import('kysely')
        const { EVENTS_PER_STATEMENT, settleHints, tenantsToList } = await import('./due-hints')
        const now = new Date('2043-01-05T00:00:00.000Z')
        const piled = EVENTS_PER_STATEMENT * 2 + 200
        await sql`
            INSERT INTO due_hint_events (tenant_id, drain, due)
            SELECT ${tenantId}::uuid, 'schedules', ${new Date(now.getTime() - MINUTE)}::timestamptz
            FROM generate_series(1, ${piled})
        `.execute(fakeDb.getDb())
        const settleOnce = async (window: { deadline: number; clock?: () => number }) => {
            const read = await tenantsToList(fakeDb, 'schedules', now)
            const tenant = read.tenants.find((t) => t.id === tenantId)!
            expect(tenant, 'the pile has come, so the tenant is listed').toBeDefined()
            await settleHints(fakeDb, 'schedules', now, read, [{ tenant, hadRows: false, nextDue: null }], window)
            return (await events(tenantId, 'schedules')).length
        }
        // A window already spent: the hint is set, and nothing is deleted.
        expect(await settleOnce({ deadline: 0, clock: () => 1 })).toBe(piled)
        // A window with time: the rest, in proportion to the pile.
        expect(await settleOnce({ deadline: Number.MAX_SAFE_INTEGER })).toBe(0)
    })

    test('the events table has no unique key, so an append can wait on no other transaction', async () => {
        const { fakeDb } = await world()
        const { sql } = await import('kysely')
        const unique = await sql<{ indexname: string }>`
            SELECT i.relname AS indexname FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
            WHERE x.indrelid = 'public.due_hint_events'::regclass AND (x.indisunique OR x.indisprimary)
        `.execute(fakeDb.getDb())
        expect(unique.rows).toEqual([])
    })
})
