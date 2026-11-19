import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { makeTestTmpDir } from '../../testing/tmp-dir'

/**
 * The in-process runner (`JOBS_RUNNER=in-process`) run against the simulated world's ports: the runner is given its
 * ports, so the fakes stand in for the deployment's real ones here, and what is tested is what it does with them
 * (claim, handler, terminal status, notification). The notification modules are stubbed: they read the adapter
 * registry, which this test has no reason to load.
 */
const notified = vi.hoisted(() => ({ calls: [] as unknown[], fail: false }))
vi.mock('../../server-lib/notify', () => ({
    notifyJobTerminal: async (_deps: unknown, _auth: unknown, input: unknown) => {
        if (notified.fail) throw new Error('mail is down')
        notified.calls.push(input)
    },
}))
vi.mock('../../server-lib/notify-deps', () => ({ makeNotifyDeps: async () => ({}) }))

const tmp = makeTestTmpDir('app-jobs-in-process-')
beforeAll(() => {
    process.env['APP_DATA_DIR'] = tmp
})
afterAll(() => {
    delete process.env['APP_DATA_DIR']
})
beforeEach(() => {
    notified.calls = []
    notified.fail = false
})

async function harness() {
    const { fakeDb } = await import('../fake/db')
    const { fakeStorage } = await import('../fake/storage')
    const { fakeEmail } = await import('../fake/email')
    const { fakeLlm } = await import('../fake/llm')
    const { fakeAuth } = await import('../fake/auth')
    const { createInProcessJobs } = await import('./jobs-in-process')
    const { submitJob, listJobs } = await import('../../db/jobs')
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
    const ports = { db: fakeDb, storage: fakeStorage, email: fakeEmail, llm: fakeLlm, auth: fakeAuth }
    const submit = async (jobs: ReturnType<typeof createInProcessJobs>) => {
        const { id } = await submitJob(fakeDb, jobs, {
            tenantId: tenant.id,
            orgId: org.id,
            kind: 'export-dockets',
            payload: {},
        })
        const view = (await listJobs(fakeDb, tenant.id, org.id)).find((v) => v.id === id)
        if (!view) throw new Error(`job ${id} not listed`)
        return view
    }
    return { ports, createInProcessJobs, submit, tenantId: tenant.id, orgId: org.id }
}

describe('the in-process jobs runner', () => {
    test("start runs the job's handler before it returns, records its timeline and notifies", async () => {
        const { ports, createInProcessJobs, submit, tenantId, orgId } = await harness()
        const view = await submit(createInProcessJobs(ports))
        expect(view.status).toBe('completed')
        expect(view.resultKey).toBe(`exports/${tenantId}/${orgId}/${view.id}.csv`)
        expect(view.timeline.map((t) => t.status)).toEqual(['queued', 'running', 'completed'])
        expect(await ports.storage.get(view.resultKey!)).not.toBeNull()
        expect(notified.calls).toEqual([{ tenantId, jobId: view.id, status: 'completed' }])
    })

    test("a handler's error fails the job, not the caller", async () => {
        const { ports, createInProcessJobs, submit, tenantId } = await harness()
        const storage = {
            ...ports.storage,
            put: async () => {
                throw new Error('bucket unreachable')
            },
        }
        const view = await submit(createInProcessJobs({ ...ports, storage }))
        expect(view.status).toBe('failed')
        expect(view.error).toBe('bucket unreachable')
        expect(notified.calls).toEqual([{ tenantId, jobId: view.id, status: 'failed' }])
    })

    test('a failed notification is logged and never fails a finished job', async () => {
        const { ports, createInProcessJobs, submit } = await harness()
        notified.fail = true
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const view = await submit(createInProcessJobs(ports))
            expect(view.status).toBe('completed')
            expect(warn).toHaveBeenCalledWith(expect.stringMatching(/is completed, but notifying its org failed: mail/))
        } finally {
            warn.mockRestore()
        }
    })

    test('a job another runner already claimed is left alone', async () => {
        const { ports, createInProcessJobs, submit, tenantId, orgId } = await harness()
        const jobs = createInProcessJobs(ports)
        const view = await submit(jobs)
        await jobs.start({ id: view.id, kind: 'export-dockets', tenantId, orgId, payload: {} })
        const { listJobs } = await import('../../db/jobs')
        const again = (await listJobs(ports.db, tenantId, orgId)).find((v) => v.id === view.id)
        expect(again?.timeline.map((t) => t.status)).toEqual(['queued', 'running', 'completed'])
        expect(notified.calls).toHaveLength(1)
    })
})
