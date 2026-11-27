import { afterAll, beforeAll, describe, expect, test } from 'vitest'
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

/**
 * Due hints (safeinsights/sssb#202, migration 0022_due_hints): the tick's drains list only the tenants whose hint has
 * come. Triggers lower a hint on every write that can make work due; a drain raises it, by compare-and-set, after
 * listing a tenant with nothing due. Driven here on the fake database, through the drains as the tick calls them.
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
    test('a future schedule sets the hint by its trigger; a tenant with no hint is listed once and raised', async () => {
        const { fakeDb, tenantId, orgId } = await world()
        const { runDueSchedules } = await import('./schedules')
        // A year on, where nothing of the other tests' is due.
        const now = new Date('2031-01-05T00:00:00.000Z')
        const at = new Date(now.getTime() + 3 * 60 * MINUTE)
        await fakeDb.getDb().deleteFrom('due_hints').where('tenant_id', '=', tenantId).execute()
        await insertSchedule(tenantId, orgId, at)
        // The insert's trigger wrote the hint: the tenant is not listed before three hours on.
        expect(new Date((await hint(tenantId, 'schedules'))!.list_after as Date).getTime()).toBeLessThanOrEqual(
            at.getTime(),
        )
        let { db, listed } = await listingCounter()
        await runDueSchedules(db, stubJobs(), now, HINTED)
        expect(listed).not.toContain(tenantId)

        // Without a hint row, the tenant is listed; with nothing due it is raised to its next due time.
        await fakeDb.getDb().deleteFrom('due_hints').where('tenant_id', '=', tenantId).execute()
        ;({ db, listed } = await listingCounter())
        await runDueSchedules(db, stubJobs(), now, HINTED)
        expect(listed).toContain(tenantId)
        const raised = await hint(tenantId, 'schedules')
        expect(raised).toBeDefined()
        expect(new Date(raised!.list_after as Date).getTime()).toBeGreaterThan(now.getTime())
        ;({ db, listed } = await listingCounter())
        await runDueSchedules(db, stubJobs(), new Date(now.getTime() + MINUTE), HINTED)
        expect(listed, 'raised, so the next tick skips it').not.toContain(tenantId)

        // A schedule due now is written: its trigger lowers the hint, and the next tick lists the tenant and fires it.
        const due = await insertSchedule(tenantId, orgId, new Date(now.getTime() + MINUTE))
        const jobs = stubJobs()
        ;({ db, listed } = await listingCounter())
        await runDueSchedules(db, jobs, new Date(now.getTime() + 2 * MINUTE), HINTED)
        expect(listed).toContain(tenantId)
        expect(jobs.calls.map((c) => (c.payload as { scheduleId: string }).scheduleId)).toContain(due)
    })

    test('a drain without hints lists every tenant, whatever the hints say', async () => {
        const { tenantId, otherTenantId } = await world()
        const { runDueSchedules } = await import('./schedules')
        const { db, listed } = await listingCounter()
        await runDueSchedules(db, stubJobs(), new Date('2031-01-05T00:05:00.000Z'), {
            maxItems: 100,
            deadline: Number.MAX_SAFE_INTEGER,
        })
        expect(listed).toEqual(expect.arrayContaining([tenantId, otherTenantId]))
    })
})

describe('the deliveries and retries drains with due hints', () => {
    test('a delivery enqueued for a tenant whose hint is far off lowers it, and the next tick delivers it', async () => {
        const { fakeDb, tenantId, orgId } = await world()
        const { createEndpoint, enqueueWebhookEvent, runDueDeliveries } = await import('./webhooks')
        const now = new Date('2032-01-01T00:00:00.000Z')
        // Nothing due: the drain raises the tenant's hint a day on.
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

    test('a retry armed for a tenant whose hint is far off lowers it, and the tick starts it when it is due', async () => {
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
        expect(new Date((await hint(tenantId, 'retries'))!.list_after as Date).getTime()).toBe(now.getTime() + MINUTE)
        const jobs = stubJobs()
        expect(await runDueRetries(fakeDb, jobs, new Date(now.getTime() + 2 * MINUTE), HINTED)).toMatchObject({
            started: 1,
        })
        expect(jobs.calls[0]).toMatchObject({ firstJobId: id, attempt: 2 })
    })
})

describe('raiseHint and tenantsToList', () => {
    test('a raise does not land over a write that lowered the hint after it was read', async () => {
        const { tenantId, orgId } = await world()
        const { raiseHint, tenantsToList } = await import('./due-hints')
        const { fakeDb } = await world()
        const now = new Date('2034-01-01T00:00:00.000Z')
        await insertSchedule(tenantId, orgId, new Date(now.getTime() - MINUTE)) // a hint row, due
        const read = (await tenantsToList(fakeDb, 'schedules', now)).find((t) => t.id === tenantId)!
        // Meanwhile a write makes more work due, bumping the hint's version.
        await insertSchedule(tenantId, orgId, new Date(now.getTime() - 2 * MINUTE))
        await raiseHint(fakeDb, read, 'schedules', now, new Date(now.getTime() + 60 * MINUTE))
        expect(new Date((await hint(tenantId, 'schedules'))!.list_after as Date).getTime()).toBeLessThanOrEqual(
            now.getTime(),
        )
    })

    test('a hint further off than a day is read as come, and unreadable hints list every tenant', async () => {
        const { fakeDb, tenantId, otherTenantId } = await world()
        const { MAX_SKIP_MS, tenantsToList } = await import('./due-hints')
        const now = new Date('2035-01-01T00:00:00.000Z')
        await fakeDb
            .getDb()
            .updateTable('due_hints')
            .set({ list_after: new Date(now.getTime() + MAX_SKIP_MS + MINUTE) })
            .where('drain', '=', 'schedules')
            .execute()
        expect((await tenantsToList(fakeDb, 'schedules', now)).map((t) => t.id)).toEqual(
            expect.arrayContaining([tenantId]),
        )

        const broken = Object.create(fakeDb, {
            getDb: {
                value: () =>
                    new Proxy(fakeDb.getDb(), {
                        get(target, prop, receiver) {
                            if (prop === 'selectFrom') {
                                return (table: string) => {
                                    if (String(table).startsWith('tenants as'))
                                        throw new Error('permission denied for table due_hints')
                                    return target.selectFrom(table as never)
                                }
                            }
                            const value = Reflect.get(target, prop, receiver)
                            return typeof value === 'function' ? value.bind(target) : value
                        },
                    }),
            },
        }) as typeof fakeDb
        const listed = await tenantsToList(broken, 'schedules', now)
        expect(listed.map((t) => t.id)).toEqual(expect.arrayContaining([tenantId, otherTenantId]))
        expect(listed.every((t) => t.unhinted === true)).toBe(true)
    })
})
