import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { makeTestTmpDir } from '../testing/tmp-dir'
import type { Membership } from '../ports/auth'
import type { JobsPort, SubmittedJob } from '../ports/jobs'

// The deferred email/sms channels are out of scope here (notify.test.ts covers them): a notification is asserted as
// the in-app row the fan-out writes.
vi.mock('../server-lib/defer', () => ({ deferAfterResponse: async () => undefined }))

const tmp = makeTestTmpDir('app-job-retries-')
beforeAll(() => {
    process.env['APP_DATA_DIR'] = tmp
})
afterAll(() => {
    delete process.env['APP_DATA_DIR']
})

/**
 * Job retries with backoff (safeinsights/sssb#135), on every server runner. The fixture's `flaky-dockets` allows three
 * attempts, one minute and then ten minutes apart, and its handler fails while its attempt is at most the payload's
 * `failTimes`. Each runner is driven the way it really runs a job and reports its end:
 *
 * - the SIMULATED runner (`fakeJobs.start`, the handler in-process, the world clock arming the retry);
 * - the IN-PROCESS runner (`createInProcessJobs`, the handler in the server, its sweep failing a lost job);
 * - the CODEBUILD runner: `start` only starts a build, and the build's end arrives through the jobs webhook
 *   (`recordWebhookCompletion`, then `notifyJobTerminal`, as the route does), redelivered once to prove it idempotent.
 *
 * The next attempt is started by the scheduled tick's `runDueRetries`, run here at instants past each delay.
 */

const MINUTE = 60_000
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

/** Every attempt of the work `firstId` began, in order, with its timeline. */
async function chain(firstId: string) {
    const { fakeDb } = await world()
    const { loadTimelines } = await import('./jobs')
    const db = fakeDb.getDb()
    const rows = await db
        .selectFrom('jobs')
        .select(['id', 'status', 'attempt', 'retry_of', 'run_after', 'error'])
        .where((eb) => eb.or([eb('id', '=', firstId), eb('retry_of', '=', firstId)]))
        .orderBy('attempt', 'asc')
        .execute()
    const timelines = await loadTimelines(
        db,
        rows.map((r) => r.id),
    )
    return rows.map((r) => ({ ...r, timeline: timelines.get(r.id) ?? [] }))
}

/** The `job.completed` notifications written for any attempt of the work `firstId` began. */
async function notificationsFor(firstId: string) {
    const { fakeDb } = await world()
    const ids = new Set((await chain(firstId)).map((r) => r.id))
    const rows = await fakeDb
        .getDb()
        .selectFrom('notifications')
        .select('payload')
        .where('kind', '=', 'job.completed')
        .execute()
    return rows
        .map((r) => r.payload as { jobId: string; status: string; attempts?: number })
        .filter((p) => ids.has(p.jobId))
        .map(({ status, attempts }) => ({ status, attempts }))
}

/** A runner as the tests drive it: how it is built, and what it takes to bring a started attempt to its end. */
interface Runner {
    name: string
    jobs: () => Promise<JobsPort>
    /** For a runner whose start does not run the job (CodeBuild), deliver the build's end; else nothing. */
    finish?: (job: SubmittedJob) => Promise<void>
}

/** The CodeBuild runner's builds: `start` records the build, `finish` posts its webhook (twice). */
const builds: SubmittedJob[] = []

const RUNNERS: Runner[] = [
    {
        name: 'the simulated runner',
        jobs: async () => (await import('../adapters/fake/jobs')).fakeJobs,
    },
    {
        name: 'the in-process runner',
        jobs: async () => {
            const { fakeDb, fakeAuth } = await world()
            const { createInProcessJobs } = await import('../adapters/real/jobs-in-process')
            const { notifyJobTerminal } = await import('../server-lib/notify')
            const { fakeStorage } = await import('../adapters/fake/storage')
            const { fakeEmail } = await import('../adapters/fake/email')
            const { fakeLlm } = await import('../adapters/fake/llm')
            const deps = { db: fakeDb, email: { send: async () => undefined }, sms: async () => undefined }
            return createInProcessJobs(
                { db: fakeDb, storage: fakeStorage, email: fakeEmail, llm: fakeLlm, auth: fakeAuth },
                (input) => notifyJobTerminal(deps, fakeAuth, input),
            )
        },
    },
    {
        name: "the CodeBuild runner's webhook",
        jobs: async () => ({
            async start(job) {
                builds.push(job)
            },
        }),
        async finish(job) {
            const { fakeDb, fakeAuth, tenantId } = await world()
            const { recordWebhookCompletion } = await import('./jobs')
            const { notifyJobTerminal } = await import('../server-lib/notify')
            const { flakyDocketsHandler } = await import('../../test-fixture/domain/flaky-dockets')
            const deps = { db: fakeDb, email: { send: async () => undefined }, sms: async () => undefined }
            // The build runs the handler, as a CodeBuild project's script would, with the context its environment gives.
            let status: 'completed' | 'failed' = 'completed'
            let error: string | undefined
            try {
                await flakyDocketsHandler(job.payload, {
                    ...({} as never),
                    tenantId,
                    orgId: job.orgId,
                    jobId: job.id,
                    attempt: job.attempt ?? 1,
                    firstJobId: job.firstJobId ?? job.id,
                })
            } catch (e) {
                status = 'failed'
                error = e instanceof Error ? e.message : String(e)
            }
            const body = { tenantId, jobId: job.id, status, ...(error !== undefined && { error }) }
            const outcome = await recordWebhookCompletion(fakeDb, body)
            expect(outcome).toBe('applied')
            if (outcome === 'applied') await notifyJobTerminal(deps, fakeAuth, { tenantId, jobId: job.id, status })
            // The vendor redelivers: idempotent, and it arms nothing more.
            expect(await recordWebhookCompletion(fakeDb, body)).toBe('idempotent')
        },
    },
]

describe.each(RUNNERS)('$name', (runner) => {
    beforeEach(async () => {
        const { fakeAuth } = await world()
        vi.spyOn(fakeAuth, 'listMembers').mockResolvedValue(MEMBERS)
        builds.length = 0
        const { flakyRuns } = await import('../../test-fixture/domain/flaky-dockets')
        flakyRuns.length = 0
    })

    /** Submits a flaky-dockets job that fails `failTimes` times, and brings its first attempt to its end. */
    async function submit(failTimes: number): Promise<string> {
        const { fakeDb, tenantId, orgId } = await world()
        const { submitJob } = await import('./jobs')
        const jobs = await runner.jobs()
        const { id } = await submitJob(fakeDb, jobs, { tenantId, orgId, kind: 'flaky-dockets', payload: { failTimes } })
        if (runner.finish) await runner.finish(builds.at(-1)!)
        return id
    }

    /** Runs the tick's retry drain at `at`, and brings what it started to its end. */
    async function tick(at: Date) {
        const { fakeDb } = await world()
        const { runDueRetries } = await import('./jobs')
        const before = builds.length
        const result = await runDueRetries(fakeDb, await runner.jobs(), at)
        if (runner.finish) for (const job of builds.slice(before)) await runner.finish(job)
        return result
    }

    test('succeeds first time: one attempt, no retry, one completion notification', async () => {
        const id = await submit(0)
        const rows = await chain(id)
        expect(rows.map((r) => [r.attempt, r.status])).toEqual([[1, 'completed']])
        expect(await notificationsFor(id)).toEqual([{ status: 'completed', attempts: undefined }])
    })

    test('fails then succeeds: the failure arms attempt 2 after its delay, notifies nothing, and attempt 2 completes', async () => {
        const failedAt = Date.now()
        const id = await submit(1)

        let rows = await chain(id)
        expect(rows.map((r) => [r.attempt, r.status, r.retry_of])).toEqual([
            [1, 'failed', null],
            [2, 'queued', id],
        ])
        const runAfter = new Date(rows[1]!.run_after as Date | string).getTime()
        expect(runAfter).toBeGreaterThanOrEqual(failedAt + MINUTE)
        expect(runAfter).toBeLessThan(Date.now() + MINUTE + 5_000)
        expect(rows[0]!.error).toBe('fixture: attempt 1 asked to fail')
        expect(rows[0]!.timeline.at(-1)!.message).toMatch(/^retry armed: attempt 2 of 3 at /)
        expect(rows[1]!.timeline).toEqual([
            expect.objectContaining({
                status: 'queued',
                message: 'attempt 2 of 3, after: fixture: attempt 1 asked to fail',
            }),
        ])
        expect(await notificationsFor(id), 'a failure with attempts left is not the end').toEqual([])

        // Not due before its delay; started once it is, and only once.
        expect(await tick(new Date(failedAt + 30_000))).toMatchObject({ started: 0 })
        expect(await tick(new Date(runAfter + 1_000))).toMatchObject({ started: 1, failed: 0 })
        expect(await tick(new Date(runAfter + 2_000))).toMatchObject({ started: 0 })

        rows = await chain(id)
        expect(rows.map((r) => [r.attempt, r.status])).toEqual([
            [1, 'failed'],
            [2, 'completed'],
        ])
        expect(rows[1]!.run_after).toBeNull()
        expect(await notificationsFor(id)).toEqual([{ status: 'completed', attempts: 2 }])
        // Every attempt the handler saw carried the first attempt's id.
        const { flakyRuns } = await import('../../test-fixture/domain/flaky-dockets')
        expect(flakyRuns.map((r) => [r.attempt, r.firstJobId])).toEqual([
            [1, id],
            [2, id],
        ])
    })

    test('fails every attempt: three rows, the last failure alone notifies, saying three attempts', async () => {
        const id = await submit(3)
        const first = await chain(id)
        await tick(new Date(new Date(first[1]!.run_after as Date | string).getTime() + 1_000))
        const second = await chain(id)
        expect(second.map((r) => [r.attempt, r.status])).toEqual([
            [1, 'failed'],
            [2, 'failed'],
            [3, 'queued'],
        ])
        // The second delay is the longer one.
        const thirdAt = new Date(second[2]!.run_after as Date | string).getTime()
        expect(thirdAt - Date.now()).toBeGreaterThan(9 * MINUTE)
        expect(await notificationsFor(id)).toEqual([])

        await tick(new Date(thirdAt + 1_000))
        const rows = await chain(id)
        expect(rows.map((r) => [r.attempt, r.status])).toEqual([
            [1, 'failed'],
            [2, 'failed'],
            [3, 'failed'],
        ])
        expect(rows[2]!.timeline.at(-1)!.message, 'no attempt is armed past the last').toBeNull()
        expect(await notificationsFor(id)).toEqual([{ status: 'failed', attempts: 3 }])
        expect(await tick(new Date(thirdAt + 3_600_000))).toMatchObject({ started: 0 })
    })
})

describe('a job lost by the in-process runner', () => {
    test('is failed by the sweep, which arms its retry, and the retry completes', async () => {
        const { fakeDb, fakeAuth, tenantId, orgId } = await world()
        vi.spyOn(fakeAuth, 'listMembers').mockResolvedValue(MEMBERS)
        const { createInProcessJobs, IN_PROCESS_CLAIM, IN_PROCESS_LOST_AFTER_MS } =
            await import('../adapters/real/jobs-in-process')
        const { notifyJobTerminal } = await import('../server-lib/notify')
        const { fakeStorage } = await import('../adapters/fake/storage')
        const { fakeEmail } = await import('../adapters/fake/email')
        const { fakeLlm } = await import('../adapters/fake/llm')
        const { recordJobStatus, runDueRetries, submitJob } = await import('./jobs')
        const deps = { db: fakeDb, email: { send: async () => undefined }, sms: async () => undefined }
        const jobs = createInProcessJobs(
            { db: fakeDb, storage: fakeStorage, email: fakeEmail, llm: fakeLlm, auth: fakeAuth },
            (input) => notifyJobTerminal(deps, fakeAuth, input),
        )
        // Claimed by the runner, then the invocation ended: the job sits `running` with the runner's claim.
        const { id } = await submitJob(
            fakeDb,
            { start: async () => undefined },
            { tenantId, orgId, kind: 'flaky-dockets', payload: { failTimes: 0 } },
        )
        await recordJobStatus(fakeDb, tenantId, id, 'running', { message: IN_PROCESS_CLAIM })

        const sweptAt = new Date(Date.now() + IN_PROCESS_LOST_AFTER_MS + MINUTE)
        expect(await jobs.sweep!(sweptAt)).toBeGreaterThanOrEqual(1)
        let rows = await chain(id)
        expect(rows.map((r) => [r.attempt, r.status])).toEqual([
            [1, 'failed'],
            [2, 'queued'],
        ])
        expect(rows[0]!.error).toMatch(/^lost: /)
        // Armed from the sweep's clock, not the real one.
        expect(new Date(rows[1]!.run_after as Date | string).getTime()).toBe(sweptAt.getTime() + MINUTE)
        expect(await notificationsFor(id), 'a lost attempt with attempts left is not the end').toEqual([])

        // A second sweep leaves the waiting retry alone: it is the tick's to start, not lost.
        await jobs.sweep!(new Date(sweptAt.getTime() + IN_PROCESS_LOST_AFTER_MS + MINUTE))
        expect((await chain(id)).map((r) => r.status)).toEqual(['failed', 'queued'])

        expect(await runDueRetries(fakeDb, jobs, new Date(sweptAt.getTime() + 2 * MINUTE))).toMatchObject({
            started: 1,
        })
        rows = await chain(id)
        expect(rows.map((r) => [r.attempt, r.status])).toEqual([
            [1, 'failed'],
            [2, 'completed'],
        ])
        expect(await notificationsFor(id)).toEqual([{ status: 'completed', attempts: 2 }])
    })
})

describe('a kind that does not retry', () => {
    test('fails once, arms nothing, and notifies its failure', async () => {
        const { fakeDb, fakeAuth, tenantId, orgId } = await world()
        vi.spyOn(fakeAuth, 'listMembers').mockResolvedValue(MEMBERS)
        const { fakeJobs } = await import('../adapters/fake/jobs')
        const { submitJob } = await import('./jobs')
        const { id } = await submitJob(fakeDb, fakeJobs, {
            tenantId,
            orgId,
            kind: 'sweep-dockets',
            payload: { fail: true },
        })
        expect((await chain(id)).map((r) => [r.attempt, r.status])).toEqual([[1, 'failed']])
        expect(await notificationsFor(id)).toEqual([{ status: 'failed', attempts: undefined }])
    })
})

describe('the retry drain', () => {
    test('claims a due retry once when two ticks race it, and a start that throws fails that attempt', async () => {
        const { fakeDb, tenantId, orgId } = await world()
        const { runDueRetries, submitJob } = await import('./jobs')
        const failing: JobsPort = { start: async () => undefined }
        const { id } = await submitJob(fakeDb, failing, {
            tenantId,
            orgId,
            kind: 'flaky-dockets',
            payload: { failTimes: 0 },
        })
        const { recordJobStatus } = await import('./jobs')
        await recordJobStatus(fakeDb, tenantId, id, 'failed', { error: 'first' })
        const due = new Date(Date.now() + 2 * MINUTE)

        const starts: SubmittedJob[] = []
        const counting: JobsPort = {
            async start(job) {
                starts.push(job)
            },
        }
        const [a, b] = await Promise.all([runDueRetries(fakeDb, counting, due), runDueRetries(fakeDb, counting, due)])
        expect(a.started + b.started).toBe(1)
        expect(starts).toEqual([expect.objectContaining({ attempt: 2, firstJobId: id, kind: 'flaky-dockets' })])

        // Attempt 2's build fails (a webhook says so): attempt 3 is armed; its start throws, which fails it for good.
        await recordJobStatus(fakeDb, tenantId, starts[0]!.id, 'failed', { error: 'second', now: due })
        const third = (await chain(id))[2]!
        const refusing: JobsPort = {
            start: async () => {
                throw new Error('StartBuild refused')
            },
        }
        const result = await runDueRetries(
            fakeDb,
            refusing,
            new Date(new Date(third.run_after as Date | string).getTime() + 1_000),
        )
        expect(result).toMatchObject({ started: 0, failed: 1 })
        const rows = await chain(id)
        expect(rows.map((r) => [r.attempt, r.status])).toEqual([
            [1, 'failed'],
            [2, 'failed'],
            [3, 'failed'],
        ])
        expect(rows[2]!.error).toBe('the jobs runner did not start it: StartBuild refused')
    })

    test("the Simulator's run-pending and builder pool leave a waiting retry alone", async () => {
        const { fakeDb, tenantId, orgId } = await world()
        const { listPendingBuilds, runPendingJobs } = await import('../adapters/fake/jobs')
        const { recordJobStatus, submitJob } = await import('./jobs')
        const { id } = await submitJob(
            fakeDb,
            { start: async () => undefined },
            { tenantId, orgId, kind: 'flaky-dockets', payload: { failTimes: 0 } },
        )
        await recordJobStatus(fakeDb, tenantId, id, 'failed', { error: 'first' })
        const retryId = (await chain(id))[1]!.id

        await runPendingJobs()
        expect((await chain(id))[1]!.status, 'run-pending does not jump the backoff').toBe('queued')
        expect((await listPendingBuilds()).map((b) => b.jobId)).not.toContain(retryId)
    })
})
