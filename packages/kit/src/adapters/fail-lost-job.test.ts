import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { makeTestTmpDir } from '../testing/tmp-dir'

const tmp = makeTestTmpDir('app-fail-lost-job-')
beforeAll(async () => {
    process.env['APP_DATA_DIR'] = tmp
    const { fakeDb } = await import('./fake/db')
    await fakeDb.ready()
}, 120_000)
afterAll(() => {
    delete process.env['APP_DATA_DIR']
})

async function world() {
    const { fakeDb } = await import('./fake/db')
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
    return { fakeDb, tenantId: tenant.id, orgId: org.id }
}

/**
 * The adapter registry's handler for a job a runner's sweep judged lost (safeinsights/sssb#231): it is what the
 * CodeBuild runner is given in a deployment, so it is driven here as that runner calls it.
 */
describe('failLostJob', () => {
    test('fails the job with its error, arms the next attempt of a kind that retries, and notifies its end', async () => {
        const { fakeDb, tenantId, orgId } = await world()
        const { failLostJob } = await import('./fail-lost-job')
        const { submitJob } = await import('../db/jobs')
        const { id } = await submitJob(
            fakeDb,
            { start: async () => undefined },
            { tenantId, orgId, kind: 'flaky-dockets', payload: {} },
        )
        const notified: unknown[] = []
        const now = new Date()
        expect(
            await failLostJob(fakeDb, async (input) => void notified.push(input), {
                tenantId,
                jobId: id,
                error: 'lost: test',
                now,
            }),
        ).toBe(true)
        const rows = await fakeDb
            .getDb()
            .selectFrom('jobs')
            .select(['status', 'error', 'attempt', 'run_after'])
            .where((eb) => eb.or([eb('id', '=', id), eb('retry_of', '=', id)]))
            .orderBy('attempt', 'asc')
            .execute()
        expect(rows.map((r) => [r.attempt, r.status, r.error])).toEqual([
            [1, 'failed', 'lost: test'],
            [2, 'queued', null],
        ])
        expect(new Date(rows[1]!.run_after as Date | string).getTime()).toBe(now.getTime() + 60_000)
        expect(notified).toEqual([{ tenantId, jobId: id, status: 'failed' }])
    })

    test('leaves a job that reached an end meanwhile, and notifies nothing', async () => {
        const { fakeDb, tenantId, orgId } = await world()
        const { failLostJob } = await import('./fail-lost-job')
        const { recordWebhookCompletion, submitJob } = await import('../db/jobs')
        const { id } = await submitJob(
            fakeDb,
            { start: async () => undefined },
            { tenantId, orgId, kind: 'export-dockets', payload: {} },
        )
        await recordWebhookCompletion(fakeDb, { tenantId, jobId: id, status: 'completed' })
        const notified: unknown[] = []
        expect(
            await failLostJob(fakeDb, async (input) => void notified.push(input), {
                tenantId,
                jobId: id,
                error: 'lost: test',
                now: new Date(),
            }),
        ).toBe(false)
        expect(notified).toEqual([])
    })
})
