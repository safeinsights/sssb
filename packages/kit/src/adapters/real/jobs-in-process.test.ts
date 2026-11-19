import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { makeTestTmpDir } from '../../testing/tmp-dir'

/**
 * The in-process runner (`JOBS_RUNNER=in-process`) run against the simulated world's ports: the runner is given its
 * ports and its notifier, so the fakes stand in for the deployment's real ones here, and what is tested is what it does
 * with them (claim, handler, deadline, terminal status, notification, the sweep of lost jobs).
 */
const tmp = makeTestTmpDir('app-jobs-in-process-')
beforeAll(() => {
    process.env['APP_DATA_DIR'] = tmp
})
afterAll(() => {
    delete process.env['APP_DATA_DIR']
})

type Notified = { tenantId: string; jobId: string; status: 'completed' | 'failed' }

async function harness() {
    const { fakeDb } = await import('../fake/db')
    const { fakeStorage } = await import('../fake/storage')
    const { fakeEmail } = await import('../fake/email')
    const { fakeLlm } = await import('../fake/llm')
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
    const ports = { db: fakeDb, storage: fakeStorage, email: fakeEmail, llm: fakeLlm }
    const notified: Notified[] = []
    const notify = async (input: Notified) => {
        notified.push(input)
    }
    const view = async (id: string) => {
        const found = (await listJobs(fakeDb, tenant.id, org.id)).find((v) => v.id === id)
        if (!found) throw new Error(`job ${id} not listed`)
        return found
    }
    const submit = async (jobs: ReturnType<typeof createInProcessJobs>) => {
        const { id } = await submitJob(fakeDb, jobs, {
            tenantId: tenant.id,
            orgId: org.id,
            kind: 'export-dockets',
            payload: {},
        })
        return view(id)
    }
    return { ports, notify, notified, createInProcessJobs, submit, view, tenantId: tenant.id, orgId: org.id }
}

describe('the in-process jobs runner', () => {
    test("start runs the job's handler before it returns, records its timeline and notifies", async () => {
        const { ports, notify, notified, createInProcessJobs, submit, tenantId, orgId } = await harness()
        const view = await submit(createInProcessJobs(ports, notify))
        expect(view.status).toBe('completed')
        expect(view.resultKey).toBe(`exports/${tenantId}/${orgId}/${view.id}.csv`)
        expect(view.timeline.map((t) => t.status)).toEqual(['queued', 'running', 'completed'])
        expect(await ports.storage.get(view.resultKey!)).not.toBeNull()
        expect(notified).toEqual([{ tenantId, jobId: view.id, status: 'completed' }])
    })

    test("a handler's error fails the job, not the caller", async () => {
        const { ports, notify, notified, createInProcessJobs, submit, tenantId } = await harness()
        const storage = {
            ...ports.storage,
            put: async () => {
                throw new Error('bucket unreachable')
            },
        }
        const view = await submit(createInProcessJobs({ ...ports, storage }, notify))
        expect(view.status).toBe('failed')
        expect(view.error).toBe('bucket unreachable')
        expect(notified).toEqual([{ tenantId, jobId: view.id, status: 'failed' }])
    })

    test('a handler still running at the deadline fails its job, and its late end changes nothing', async () => {
        const { ports, notify, notified, createInProcessJobs, submit, tenantId } = await harness()
        const { IN_PROCESS_DEADLINE_MS } = await import('./jobs-in-process')
        let release: (() => void) | undefined
        const storage = {
            ...ports.storage,
            // Never settles until released, then rejects: the abandoned handler's late failure must go nowhere.
            put: () =>
                new Promise<void>((_, reject) => {
                    release = () => reject(new Error('late'))
                }),
        }
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        try {
            const submitted = submit(createInProcessJobs({ ...ports, storage }, notify))
            await vi.waitFor(() => expect(release).toBeDefined())
            await vi.advanceTimersByTimeAsync(IN_PROCESS_DEADLINE_MS)
            const view = await submitted
            expect(view.status).toBe('failed')
            expect(view.error).toBe(`timed out after ${IN_PROCESS_DEADLINE_MS / 1000} seconds in the in-process runner`)
            expect(notified).toEqual([{ tenantId, jobId: view.id, status: 'failed' }])
        } finally {
            vi.useRealTimers()
        }
        release?.()
    })

    test('a failed notification is logged and never fails a finished job', async () => {
        const { ports, createInProcessJobs, submit } = await harness()
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const view = await submit(
                createInProcessJobs(ports, async () => {
                    throw new Error('mail is down')
                }),
            )
            expect(view.status).toBe('completed')
            expect(warn).toHaveBeenCalledWith(expect.stringMatching(/is completed, but notifying its org failed: mail/))
        } finally {
            warn.mockRestore()
        }
    })

    test('a job another runner already claimed is left alone', async () => {
        const { ports, notify, notified, createInProcessJobs, submit, view, tenantId, orgId } = await harness()
        const jobs = createInProcessJobs(ports, notify)
        const done = await submit(jobs)
        await jobs.start({ id: done.id, kind: 'export-dockets', tenantId, orgId, payload: {} })
        expect((await view(done.id)).timeline.map((t) => t.status)).toEqual(['queued', 'running', 'completed'])
        expect(notified).toHaveLength(1)
    })

    test('the sweep fails a job left running past the lost-after window, and only that one', async () => {
        const { ports, notify, notified, createInProcessJobs, view, tenantId, orgId } = await harness()
        const { IN_PROCESS_LOST_AFTER_MS } = await import('./jobs-in-process')
        const { submitJob, recordJobStatus } = await import('../../db/jobs')
        // Two jobs left `running`, as an invocation cut off mid-handler leaves one: a held runner starts nothing.
        const held = { start: async () => {} }
        const lost = await submitJob(ports.db, held, { tenantId, orgId, kind: 'export-dockets', payload: {} })
        const fresh = await submitJob(ports.db, held, { tenantId, orgId, kind: 'export-dockets', payload: {} })
        for (const { id } of [lost, fresh]) await recordJobStatus(ports.db, tenantId, id, 'running')
        const stale = new Date(Date.now() - IN_PROCESS_LOST_AFTER_MS - 60_000)
        await ports.db.withTenant(tenantId, (trx) =>
            trx.updateTable('jobs').set({ updated_at: stale.toISOString() }).where('id', '=', lost.id).execute(),
        )

        const jobs = createInProcessJobs(ports, notify)
        expect(await jobs.sweep?.(new Date())).toBe(1)
        expect((await view(lost.id)).status).toBe('failed')
        expect((await view(lost.id)).error).toMatch(/^lost: /)
        expect((await view(fresh.id)).status).toBe('running')
        expect(notified).toEqual([{ tenantId, jobId: lost.id, status: 'failed' }])
        expect(await jobs.sweep?.(new Date())).toBe(0)
    })
})
