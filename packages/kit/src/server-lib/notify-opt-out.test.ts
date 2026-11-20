import { jobNotify } from '@sssb/app-config/jobs'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { makeTestTmpDir } from '../testing/tmp-dir'
import type { Membership } from '../ports/auth'
import type { JobNotify } from '../core/jobs'

// The deferred email/sms channels are out of scope (notify.test.ts says why): what is asserted here is whether the
// fan-out STARTED at all, as a `listMembers` call (the IdP call a refused kind must not make) and as an in-app row.
vi.mock('./defer', () => ({ deferAfterResponse: async () => undefined }))

const tmp = makeTestTmpDir('app-notify-opt-out-')
beforeAll(() => {
    process.env['APP_DATA_DIR'] = tmp
})
afterAll(() => {
    delete process.env['APP_DATA_DIR']
})

/**
 * A job kind's `jobNotify` (the fixture's seam: `export-dockets` says nothing, `sweep-dockets` is `failure`,
 * `quiet-dockets` is `never`) decides whether its terminal state notifies. Every runner is driven through the
 * notification hop it really uses, for every kind and both terminal states, so a runner that missed the setting
 * would show as a notification the kind refused: the simulated runner (`fakeJobs.start`), the in-process runner
 * (`createInProcessJobs`, which also fails a lost job from its sweep), and the CodeBuild runner, which reports
 * through the jobs webhook (`recordWebhookCompletion`, then `notifyJobTerminal`, as the route does).
 */

const KINDS: { kind: string; mode: JobNotify }[] = [
    { kind: 'export-dockets', mode: 'always' },
    { kind: 'sweep-dockets', mode: 'failure' },
    { kind: 'quiet-dockets', mode: 'never' },
]
const STATUSES = ['completed', 'failed'] as const
const CASES = KINDS.flatMap(({ kind, mode }) => STATUSES.map((status) => ({ kind, mode, status })))
const expected = (mode: JobNotify, status: 'completed' | 'failed') =>
    mode === 'always' || (mode === 'failure' && status === 'failed')

const MEMBERS: Membership[] = [
    { id: 'admin-active', email: 'admin@example.test', name: 'admin', role: 'admin', status: 'active' } as Membership,
]

async function world() {
    const { fakeDb } = await import('../adapters/fake/db')
    const { fakeAuth } = await import('../adapters/fake/auth')
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
    return { fakeDb, fakeAuth, tenantId: tenant.id, orgId: org.id }
}

async function inAppRows(jobId: string): Promise<{ status: unknown }[]> {
    const { fakeDb } = await world()
    const rows = await fakeDb
        .getDb()
        .selectFrom('notifications')
        .select('payload')
        .where('kind', '=', 'job.completed')
        .execute()
    return rows
        .filter((r) => (r.payload as { jobId?: string }).jobId === jobId)
        .map((r) => ({ status: (r.payload as { status?: unknown }).status }))
}

/** The assertion every runner shares: the fan-out ran (and notified the job's own status) or it never started. */
async function expectNotified(listMembers: ReturnType<typeof vi.fn>, jobId: string, yes: boolean, status: string) {
    expect(listMembers).toHaveBeenCalledTimes(yes ? 1 : 0)
    expect(await inAppRows(jobId)).toEqual(yes ? [{ status }] : [])
}

test('the fixture seam sets what the table below assumes: one kind of each mode, and one that says nothing', () => {
    expect(jobNotify).toEqual({ 'sweep-dockets': 'failure', 'quiet-dockets': 'never' })
    expect(KINDS.map((k) => k.kind)).toEqual(['export-dockets', ...Object.keys(jobNotify)])
})

describe.each(CASES)('$kind ($mode) ending $status', ({ kind, mode, status }) => {
    const yes = expected(mode, status)
    const payload = status === 'failed' ? { fail: true } : {}
    // `export-dockets` ignores `fail`: its failure is a storage error, so its failing case breaks the port instead.
    const failing = kind === 'export-dockets' && status === 'failed'
    let listMembers: ReturnType<typeof vi.fn>

    beforeEach(async () => {
        const { fakeAuth } = await world()
        listMembers = vi.spyOn(fakeAuth, 'listMembers').mockResolvedValue(MEMBERS).mockClear() as never
    })

    test(`the simulated runner ${yes ? 'notifies' : 'does not notify'}`, async () => {
        const { fakeDb, tenantId, orgId } = await world()
        const { fakeJobs } = await import('../adapters/fake/jobs')
        const { fakeStorage } = await import('../adapters/fake/storage')
        const { submitJob } = await import('../db/jobs')
        const put = failing
            ? vi.spyOn(fakeStorage, 'put').mockRejectedValueOnce(new Error('storage is down'))
            : undefined
        try {
            const { id } = await submitJob(fakeDb, fakeJobs, { tenantId, orgId, kind, payload })
            await expectNotified(listMembers, id, yes, status)
        } finally {
            put?.mockRestore()
        }
    })

    test(`the in-process runner ${yes ? 'notifies' : 'does not notify'}`, async () => {
        const { fakeDb, fakeAuth, tenantId, orgId } = await world()
        const { createInProcessJobs } = await import('../adapters/real/jobs-in-process')
        const { notifyJobTerminal } = await import('./notify')
        const { fakeStorage } = await import('../adapters/fake/storage')
        const { fakeEmail } = await import('../adapters/fake/email')
        const { fakeLlm } = await import('../adapters/fake/llm')
        const { submitJob } = await import('../db/jobs')
        const deps = { db: fakeDb, email: { send: async () => undefined }, sms: async () => undefined }
        const jobs = createInProcessJobs(
            { db: fakeDb, storage: fakeStorage, email: fakeEmail, llm: fakeLlm, auth: fakeAuth },
            (input) => notifyJobTerminal(deps, fakeAuth, input),
        )
        const put = failing
            ? vi.spyOn(fakeStorage, 'put').mockRejectedValueOnce(new Error('storage is down'))
            : undefined
        try {
            const { id } = await submitJob(fakeDb, jobs, { tenantId, orgId, kind, payload })
            await expectNotified(listMembers, id, yes, status)
        } finally {
            put?.mockRestore()
        }
    })

    test(`the CodeBuild runner's webhook ${yes ? 'notifies' : 'does not notify'}`, async () => {
        const { fakeDb, fakeAuth, tenantId, orgId } = await world()
        const { recordWebhookCompletion, submitJob } = await import('../db/jobs')
        const { notifyJobTerminal } = await import('./notify')
        const deps = { db: fakeDb, email: { send: async () => undefined }, sms: async () => undefined }
        // A build that has started and not reported: the job stays queued until the webhook arrives.
        const { id } = await submitJob(fakeDb, { start: async () => undefined }, { tenantId, orgId, kind, payload })
        const outcome = await recordWebhookCompletion(fakeDb, { tenantId, jobId: id, status })
        expect(outcome).toBe('applied')
        await notifyJobTerminal(deps, fakeAuth, { tenantId, jobId: id, status })
        await expectNotified(listMembers, id, yes, status)
    })
})

describe('the in-process runner sweep', () => {
    test.each(KINDS)(
        'fails a lost $kind ($mode) job, and notifies it only where the kind notifies a failure',
        async ({ kind, mode }) => {
            const { fakeDb, fakeAuth, tenantId, orgId } = await world()
            const { createInProcessJobs, IN_PROCESS_CLAIM, IN_PROCESS_LOST_AFTER_MS } =
                await import('../adapters/real/jobs-in-process')
            const { notifyJobTerminal } = await import('./notify')
            const { fakeStorage } = await import('../adapters/fake/storage')
            const { fakeEmail } = await import('../adapters/fake/email')
            const { fakeLlm } = await import('../adapters/fake/llm')
            const { submitJob, recordJobStatus } = await import('../db/jobs')
            const listMembers = vi.spyOn(fakeAuth, 'listMembers').mockResolvedValue(MEMBERS).mockClear()
            const deps = { db: fakeDb, email: { send: async () => undefined }, sms: async () => undefined }
            const jobs = createInProcessJobs(
                { db: fakeDb, storage: fakeStorage, email: fakeEmail, llm: fakeLlm, auth: fakeAuth },
                (input) => notifyJobTerminal(deps, fakeAuth, input),
            )
            const { id } = await submitJob(
                fakeDb,
                { start: async () => undefined },
                { tenantId, orgId, kind, payload: {} },
            )
            await recordJobStatus(fakeDb, tenantId, id, 'running', { message: IN_PROCESS_CLAIM })

            const swept = await jobs.sweep!(new Date(Date.now() + IN_PROCESS_LOST_AFTER_MS + 60_000))

            expect(swept).toBeGreaterThanOrEqual(1)
            await expectNotified(listMembers, id, expected(mode, 'failed'), 'failed')
        },
    )
})

describe('a seam that does not say, or says something else', () => {
    // An app that never added `jobNotify` (the starter, an adopter before it adopts), and a value the types would
    // refuse but an untyped seam could still hold: both leave the kind notifying, as every kind did before.
    test.each([
        ['has no jobNotify export', undefined],
        ['holds a value that is not a mode', { 'quiet-dockets': 'sometimes' }],
        ['names no entry for the kind', { 'sweep-dockets': 'never' }],
    ])('a seam that %s still notifies a quiet-dockets job', async (_name, jobNotify) => {
        // The fake world is taken BEFORE the modules reset, so there is one database, not two on one directory.
        const { fakeDb, fakeAuth, tenantId, orgId } = await world()
        const { submitJob } = await import('../db/jobs')
        const listMembers = vi.spyOn(fakeAuth, 'listMembers').mockResolvedValue(MEMBERS).mockClear()
        const { id } = await submitJob(
            fakeDb,
            { start: async () => undefined },
            { tenantId, orgId, kind: 'quiet-dockets', payload: {} },
        )
        vi.resetModules()
        vi.doMock('@sssb/app-config/jobs', async (importOriginal) => ({
            ...(await importOriginal<Record<string, unknown>>()),
            jobNotify,
        }))
        try {
            const { notifyJobTerminal } = await import('./notify')
            const deps = { db: fakeDb, email: { send: async () => undefined }, sms: async () => undefined }

            await notifyJobTerminal(deps, fakeAuth, { tenantId, jobId: id, status: 'completed' })

            expect(listMembers).toHaveBeenCalledTimes(1)
        } finally {
            vi.doUnmock('@sssb/app-config/jobs')
            vi.resetModules()
        }
    })
})
