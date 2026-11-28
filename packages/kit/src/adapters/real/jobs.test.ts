import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { makeTestTmpDir } from '../../testing/tmp-dir'

/**
 * The CodeBuild runner with the SDK replaced by a fake CodeBuild: what context a build is given, which build the job
 * records, and how the sweep tells a lost build from a running or finished one (safeinsights/sssb#231). Never run
 * against a real project (cutover row `job-runner`): what only a deployment shows is the server role's permission to
 * call BatchGetBuilds, the statuses and end times CodeBuild really reports, and how long a real webhook takes.
 */

/** The fake CodeBuild: StartBuild returns the next id (or none); BatchGetBuilds answers from `builds`. */
const codebuild = vi.hoisted(() => ({
    started: [] as { projectName: string; environmentVariablesOverride: { name: string; value: string }[] }[],
    nextIds: [] as (string | undefined)[],
    builds: new Map<string, { buildStatus: string; endTime?: Date }>(),
    batchCalls: [] as string[][],
    batchFails: false,
    /** When set, the next StartBuild throws an SDK-shaped error with this fault. */
    startFault: undefined as 'client' | 'server' | undefined,
}))
vi.mock('@aws-sdk/client-codebuild', () => {
    class StartBuildCommand {
        input: (typeof codebuild.started)[number]
        constructor(input: (typeof codebuild.started)[number]) {
            this.input = input
        }
    }
    class BatchGetBuildsCommand {
        input: { ids: string[] }
        constructor(input: { ids: string[] }) {
            this.input = input
        }
    }
    return {
        StartBuildCommand,
        BatchGetBuildsCommand,
        CodeBuildClient: class {
            async send(command: unknown) {
                if (command instanceof StartBuildCommand) {
                    if (codebuild.startFault) {
                        const fault = codebuild.startFault
                        codebuild.startFault = undefined
                        throw Object.assign(new Error(`StartBuild failed (${fault})`), { $fault: fault })
                    }
                    codebuild.started.push(command.input)
                    const id =
                        codebuild.nextIds.length > 0 ? codebuild.nextIds.shift() : `proj:${codebuild.started.length}`
                    return id === undefined ? {} : { build: { id } }
                }
                if (command instanceof BatchGetBuildsCommand) {
                    if (codebuild.batchFails) throw new Error('AccessDeniedException: not authorized to BatchGetBuilds')
                    codebuild.batchCalls.push(command.input.ids)
                    const builds = command.input.ids.flatMap((id) => {
                        const build = codebuild.builds.get(id)
                        return build ? [{ id, ...build }] : []
                    })
                    return { builds, buildsNotFound: command.input.ids.filter((id) => !codebuild.builds.has(id)) }
                }
                throw new Error('unexpected command')
            }
        },
    }
})

const tmp = makeTestTmpDir('app-codebuild-jobs-')
beforeAll(async () => {
    process.env['APP_DATA_DIR'] = tmp
    await world()
}, 120_000)
afterAll(() => {
    delete process.env['APP_DATA_DIR']
})
beforeEach(async () => {
    // Each test judges only its own jobs: whatever an earlier one left open is closed, outside the runner.
    const { fakeDb } = await world()
    await fakeDb
        .getDb()
        .updateTable('jobs')
        .set({ status: 'completed' })
        .where('status', 'in', ['queued', 'running'])
        .execute()
    codebuild.started.length = 0
    codebuild.nextIds.length = 0
    codebuild.builds.clear()
    codebuild.batchCalls.length = 0
    codebuild.batchFails = false
    codebuild.startFault = undefined
})

const MINUTE = 60_000

async function world() {
    const { fakeDb } = await import('../fake/db')
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
    return { fakeDb, tenantId: tenant.id, orgId: org.id }
}

/** The runner as the registry builds it: its `failLost` is the registry's (../fail-lost-job.ts), with a notifier that notes. */
async function runner() {
    const { fakeDb } = await world()
    const { createRealJobs } = await import('./jobs')
    const { failLostJob } = await import('../fail-lost-job')
    const notified: string[] = []
    const notify = async (input: { jobId: string }) => void notified.push(input.jobId)
    const jobs = createRealJobs('proj', 'us-east-1', fakeDb, (input) => failLostJob(fakeDb, notify, input))
    return { jobs, notified }
}

async function row(jobId: string) {
    const { fakeDb } = await world()
    return fakeDb
        .getDb()
        .selectFrom('jobs')
        .select(['status', 'runner_ref', 'error', 'attempt', 'retry_of', 'run_after'])
        .where('id', '=', jobId)
        .executeTakeFirstOrThrow()
}

/** Submits a job through the runner (so a build starts), then dates its last change `ageMs` ago. */
async function submitted(jobs: Awaited<ReturnType<typeof runner>>['jobs'], kind = 'export-dockets', ageMs = 0) {
    const { fakeDb, tenantId, orgId } = await world()
    const { submitJob } = await import('../../db/jobs')
    const { id } = await submitJob(fakeDb, jobs, { tenantId, orgId, kind, payload: { a: 1 } })
    if (ageMs > 0) {
        await fakeDb
            .getDb()
            .updateTable('jobs')
            .set({ updated_at: new Date(Date.now() - ageMs).toISOString() })
            .where('id', '=', id)
            .execute()
    }
    return id
}

describe('the CodeBuild jobs runner: starting a build', () => {
    test("starts the project's build with the job's whole context, and records the build's id", async () => {
        const { jobs } = await runner()
        codebuild.nextIds.push('proj:abc')
        const id = await submitted(jobs)
        expect(codebuild.started).toEqual([
            {
                projectName: 'proj',
                environmentVariablesOverride: [
                    { name: 'JOB_ID', value: id, type: 'PLAINTEXT' },
                    { name: 'JOB_KIND', value: 'export-dockets', type: 'PLAINTEXT' },
                    { name: 'JOB_TENANT_ID', value: (await world()).tenantId, type: 'PLAINTEXT' },
                    { name: 'JOB_ORG_ID', value: (await world()).orgId, type: 'PLAINTEXT' },
                    { name: 'JOB_PAYLOAD', value: '{"a":1}', type: 'PLAINTEXT' },
                    { name: 'JOB_ATTEMPT', value: '1', type: 'PLAINTEXT' },
                    { name: 'JOB_FIRST_ID', value: id, type: 'PLAINTEXT' },
                ],
            },
        ])
        expect((await row(id)).runner_ref).toBe('proj:abc')
    })

    test("a retry's build is told which attempt it is and the first attempt's id (safeinsights/sssb#135)", async () => {
        const { createRealJobs } = await import('./jobs')
        const { fakeDb, tenantId } = await world()
        await createRealJobs('proj', 'us-east-1', fakeDb).start({
            id: '00000000-0000-4000-8000-000000000003',
            kind: 'export-dockets',
            tenantId,
            orgId: null,
            payload: {},
            attempt: 3,
            firstJobId: '00000000-0000-4000-8000-000000000001',
        })
        const overrides = codebuild.started[0]!.environmentVariablesOverride
        expect(overrides).toContainEqual({ name: 'JOB_ATTEMPT', value: '3', type: 'PLAINTEXT' })
        expect(overrides).toContainEqual({
            name: 'JOB_FIRST_ID',
            value: '00000000-0000-4000-8000-000000000001',
            type: 'PLAINTEXT',
        })
        expect(overrides).toContainEqual({ name: 'JOB_ORG_ID', value: '', type: 'PLAINTEXT' })
    })

    test('a runner built without failLost (a caller building the real ports itself) has no sweep', async () => {
        const { createRealJobs } = await import('./jobs')
        const { fakeDb } = await world()
        expect(createRealJobs('proj', 'us-east-1', fakeDb).sweep).toBeUndefined()
    })
})

describe("the CodeBuild jobs runner: a job's row is `starting` from its first write (safeinsights/sssb#251)", () => {
    test("submitJob, a schedule spawn and a retry claim write the runner's starting ref with the row", async () => {
        const { fakeDb, tenantId, orgId } = await world()
        const { jobs } = await runner()
        const { recordJobStatus, runDueRetries, submitJob } = await import('../../db/jobs')
        const { runDueSchedules } = await import('../../db/schedules')
        expect(jobs.startingRef).toBe('starting')

        // A runner whose start throws before it writes anything: the row still says the runner owns it.
        const refusing = { startingRef: 'starting', start: async () => Promise.reject(new Error('down')) }
        await expect(
            submitJob(fakeDb, refusing, { tenantId, orgId, kind: 'export-dockets', payload: {} }),
        ).rejects.toThrow()
        const submitted = await fakeDb
            .getDb()
            .selectFrom('jobs')
            .select(['id', 'runner_ref'])
            .where('tenant_id', '=', tenantId)
            .orderBy('created_at', 'desc')
            .executeTakeFirstOrThrow()
        expect(submitted.runner_ref).toBe('starting')

        const schedule = await fakeDb
            .getDb()
            .insertInto('job_schedules')
            .values({
                tenant_id: tenantId,
                org_id: orgId,
                kind: 'digest-email',
                spec: { type: 'weekly', utcDay: 1, atUtcHour: 13, atUtcMinute: 0 },
                next_run_at: new Date('2001-01-01T00:00:00.000Z'),
                created_by: 'test',
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        await runDueSchedules(
            fakeDb,
            { startingRef: 'starting', start: async () => undefined },
            new Date('2001-02-01T00:00:00.000Z'),
        )
        const spawned = await fakeDb
            .getDb()
            .selectFrom('jobs')
            .select(['runner_ref', 'payload'])
            .where('tenant_id', '=', tenantId)
            .where('kind', '=', 'digest-email')
            .execute()
        expect(
            spawned
                .filter((j) => (j.payload as { scheduleId?: string }).scheduleId === schedule.id)
                .map((j) => j.runner_ref),
        ).toEqual(['starting'])

        const { id: first } = await submitJob(
            fakeDb,
            { start: async () => undefined },
            { tenantId, orgId, kind: 'flaky-dockets', payload: {} },
        )
        const armed = await recordJobStatus(fakeDb, tenantId, first, 'failed', {
            error: 'one',
            now: new Date(Date.now() - 2 * MINUTE),
        })
        expect((await row(armed.retry!.jobId)).runner_ref).toBeNull()
        await runDueRetries(fakeDb, { startingRef: 'starting', start: async () => undefined }, new Date())
        expect((await row(armed.retry!.jobId)).runner_ref).toBe('starting')
    })

    test('a submitted job whose start never wrote anything is failed by the sweep after the hour', async () => {
        const { fakeDb, tenantId, orgId } = await world()
        const { jobs } = await runner()
        const { submitJob } = await import('../../db/jobs')
        const refusing = { startingRef: 'starting', start: async () => Promise.reject(new Error('down')) }
        await submitJob(fakeDb, refusing, { tenantId, orgId, kind: 'export-dockets', payload: {} }).catch(
            () => undefined,
        )
        const id = (
            await fakeDb
                .getDb()
                .selectFrom('jobs')
                .select('id')
                .where('tenant_id', '=', tenantId)
                .orderBy('created_at', 'desc')
                .executeTakeFirstOrThrow()
        ).id
        await fakeDb
            .getDb()
            .updateTable('jobs')
            .set({ updated_at: new Date(Date.now() - 61 * MINUTE).toISOString() })
            .where('id', '=', id)
            .execute()
        expect(await jobs.sweep!(new Date())).toBe(1)
        expect((await row(id)).error).toBe('lost: its CodeBuild build was never recorded as started')
    })
})

describe('the CodeBuild jobs runner: a bounded sweep (safeinsights/sssb#252)', () => {
    test('fails at most its count, judges nothing after its deadline, and leaves the rest for the next', async () => {
        const { jobs } = await runner()
        const ids: string[] = []
        for (let i = 0; i < 4; i++) {
            const id = await submitted(jobs, 'export-dockets', 30 * MINUTE)
            codebuild.builds.set((await row(id)).runner_ref!, {
                buildStatus: 'FAILED',
                endTime: new Date(Date.now() - 20 * MINUTE),
            })
            ids.push(id)
        }
        expect(await jobs.sweep!(new Date(), { maxItems: 3, deadline: Number.MAX_SAFE_INTEGER })).toBe(3)
        expect(await jobs.sweep!(new Date(), { maxItems: 3, deadline: 0, clock: () => 1 })).toBe(0)
        expect(await jobs.sweep!(new Date(), { maxItems: 3, deadline: Number.MAX_SAFE_INTEGER })).toBe(1)
        for (const id of ids) expect((await row(id)).status).toBe('failed')
    })
})

describe('the CodeBuild jobs runner: the sweep for lost builds (safeinsights/sssb#231)', () => {
    test('fails a job whose build ended without reporting, and notifies its end', async () => {
        const { jobs, notified } = await runner()
        const id = await submitted(jobs, 'export-dockets', 30 * MINUTE)
        const build = (await row(id)).runner_ref!
        codebuild.builds.set(build, { buildStatus: 'FAILED', endTime: new Date(Date.now() - 20 * MINUTE) })

        expect(await jobs.sweep!(new Date())).toBe(1)
        expect(await row(id)).toMatchObject({
            status: 'failed',
            error: "lost: its CodeBuild build ended FAILED without reporting the job's end",
        })
        expect(notified).toEqual([id])
        expect(await jobs.sweep!(new Date()), 'a failed job is not judged again').toBe(0)
    })

    test.each(['SUCCEEDED', 'FAULT', 'STOPPED', 'TIMED_OUT'])(
        'takes a build that ended %s unreported for lost',
        async (status) => {
            const { jobs } = await runner()
            const id = await submitted(jobs, 'export-dockets', 30 * MINUTE)
            codebuild.builds.set((await row(id)).runner_ref!, {
                buildStatus: status,
                endTime: new Date(Date.now() - 20 * MINUTE),
            })
            expect(await jobs.sweep!(new Date())).toBe(1)
            expect((await row(id)).error).toContain(`ended ${status}`)
        },
    )

    test('leaves a build still in progress alone, however long it has run, and one that ended too recently for its webhook', async () => {
        const { jobs } = await runner()
        const running = await submitted(jobs, 'export-dockets', 24 * 60 * MINUTE)
        const justEnded = await submitted(jobs, 'export-dockets', 30 * MINUTE)
        codebuild.builds.set((await row(running)).runner_ref!, { buildStatus: 'IN_PROGRESS' })
        codebuild.builds.set((await row(justEnded)).runner_ref!, {
            buildStatus: 'SUCCEEDED',
            endTime: new Date(Date.now() - MINUTE),
        })
        expect(await jobs.sweep!(new Date())).toBe(0)
        expect((await row(running)).status).toBe('queued')
        expect((await row(justEnded)).status).toBe('queued')
    })

    test('fails a job whose build CodeBuild has no record of, and one whose start never recorded a build', async () => {
        const { jobs } = await runner()
        const forgotten = await submitted(jobs, 'export-dockets', 30 * MINUTE) // no entry in the fake: buildsNotFound
        codebuild.nextIds.push(undefined)
        const unstarted = await submitted(jobs, 'export-dockets', 61 * MINUTE)
        expect((await row(unstarted)).runner_ref).toBe('starting')

        expect(await jobs.sweep!(new Date())).toBe(2)
        expect((await row(forgotten)).error).toBe('lost: CodeBuild has no record of its build')
        expect((await row(unstarted)).error).toBe('lost: its CodeBuild build was never recorded as started')
    })

    test('gives a job left starting an hour before it is taken for one whose build never started', async () => {
        const { jobs } = await runner()
        codebuild.nextIds.push(undefined)
        const unstarted = await submitted(jobs, 'export-dockets', 30 * MINUTE)
        expect(await jobs.sweep!(new Date())).toBe(0)
        expect((await row(unstarted)).status).toBe('queued')
        expect(await jobs.sweep!(new Date(Date.now() + 31 * MINUTE))).toBe(1)
        expect((await row(unstarted)).error).toBe('lost: its CodeBuild build was never recorded as started')
    })

    test('a StartBuild CodeBuild refused is failed after five minutes; one that may have started a build waits the hour', async () => {
        const { fakeDb, tenantId, orgId } = await world()
        const { jobs } = await runner()
        const { submitJob } = await import('../../db/jobs')
        const submit = () => submitJob(fakeDb, jobs, { tenantId, orgId, kind: 'export-dockets', payload: {} })
        codebuild.startFault = 'client'
        await expect(submit()).rejects.toThrow(/StartBuild failed/)
        codebuild.startFault = 'server'
        await expect(submit()).rejects.toThrow(/StartBuild failed/)
        const rows = await fakeDb
            .getDb()
            .selectFrom('jobs')
            .select(['id', 'runner_ref'])
            .where('status', '=', 'queued')
            .where('runner_ref', 'in', ['refused', 'starting'])
            .orderBy('created_at', 'asc')
            .execute()
        expect(rows.map((r) => r.runner_ref)).toEqual(['refused', 'starting'])
        await fakeDb
            .getDb()
            .updateTable('jobs')
            .set({ updated_at: new Date(Date.now() - 10 * MINUTE).toISOString() })
            .where(
                'id',
                'in',
                rows.map((r) => r.id),
            )
            .execute()

        expect(await jobs.sweep!(new Date())).toBe(1)
        expect((await row(rows[0]!.id)).error).toBe('lost: CodeBuild refused to start its build')
        expect((await row(rows[1]!.id)).status).toBe('queued')
    })

    test('judges a job its webhook walked to running, or a service caller did, as it judges a queued one', async () => {
        const { fakeDb, tenantId } = await world()
        const { jobs } = await runner()
        const { recordJobStatus } = await import('../../db/jobs')
        const id = await submitted(jobs)
        await recordJobStatus(fakeDb, tenantId, id, 'running', { message: 'service caller' })
        await fakeDb
            .getDb()
            .updateTable('jobs')
            .set({ updated_at: new Date(Date.now() - 30 * MINUTE).toISOString() })
            .where('id', '=', id)
            .execute()
        codebuild.builds.set((await row(id)).runner_ref!, {
            buildStatus: 'FAILED',
            endTime: new Date(Date.now() - 20 * MINUTE),
        })
        expect(await jobs.sweep!(new Date())).toBe(1)
        expect((await row(id)).status).toBe('failed')
    })

    test('does not judge a job quiet for less than the grace, one with no runner_ref, or one already ended', async () => {
        const { fakeDb, tenantId, orgId } = await world()
        const { jobs } = await runner()
        const { recordWebhookCompletion, submitJob } = await import('../../db/jobs')
        const recent = await submitted(jobs, 'export-dockets', MINUTE)
        // A job written before the runner recorded builds: no runner_ref, so never judged.
        const { id: legacy } = await submitJob(
            fakeDb,
            { start: async () => undefined },
            { tenantId, orgId, kind: 'export-dockets', payload: {} },
        )
        await fakeDb
            .getDb()
            .updateTable('jobs')
            .set({ updated_at: new Date(Date.now() - 60 * MINUTE).toISOString() })
            .where('id', '=', legacy)
            .execute()
        const reported = await submitted(jobs, 'export-dockets', 30 * MINUTE)
        await recordWebhookCompletion(fakeDb, { tenantId, jobId: reported, status: 'completed' })

        expect(await jobs.sweep!(new Date())).toBe(0)
        expect((await row(recent)).status).toBe('queued')
        expect((await row(legacy)).status).toBe('queued')
        expect(codebuild.batchCalls.flat()).not.toContain((await row(reported)).runner_ref)
    })

    test('a job whose webhook lands while it is being judged is left as its webhook says', async () => {
        const { fakeDb, tenantId } = await world()
        const { createRealJobs } = await import('./jobs')
        const { recordJobStatus, recordWebhookCompletion } = await import('../../db/jobs')
        const { InvalidTransitionError } = await import('../../core/state-machine')
        // failLost as the registry's, but the build's webhook arrives just before it writes.
        const jobs = createRealJobs('proj', 'us-east-1', fakeDb, async ({ jobId, error, now }) => {
            await recordWebhookCompletion(fakeDb, { tenantId, jobId, status: 'completed' })
            try {
                await recordJobStatus(fakeDb, tenantId, jobId, 'failed', { error, now })
            } catch (failure) {
                if (failure instanceof InvalidTransitionError) return false
                throw failure
            }
            return true
        })
        const id = await submitted(jobs, 'export-dockets', 30 * MINUTE)
        codebuild.builds.set((await row(id)).runner_ref!, {
            buildStatus: 'SUCCEEDED',
            endTime: new Date(Date.now() - 20 * MINUTE),
        })
        expect(await jobs.sweep!(new Date())).toBe(0)
        expect((await row(id)).status).toBe('completed')
    })

    test('a sweep that cannot read builds fails nothing and does not throw', async () => {
        const { jobs } = await runner()
        const id = await submitted(jobs, 'export-dockets', 30 * MINUTE)
        codebuild.batchFails = true
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            expect(await jobs.sweep!(new Date())).toBe(0)
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not read builds'))
        } finally {
            warn.mockRestore()
        }
        expect((await row(id)).status).toBe('queued')
    })

    test('asks about at most 100 builds a call', async () => {
        const { jobs } = await runner()
        for (let i = 0; i < 101; i++) await submitted(jobs, 'export-dockets', 30 * MINUTE)
        await jobs.sweep!(new Date())
        expect(codebuild.batchCalls.map((ids) => ids.length).sort((a, b) => b - a)[0]).toBeLessThanOrEqual(100)
        expect(codebuild.batchCalls.flat().length).toBeGreaterThanOrEqual(101)
    })

    test('a lost build of a kind that retries arms its next attempt, which a new build completes', async () => {
        const { fakeDb, tenantId } = await world()
        const { jobs, notified } = await runner()
        const { recordWebhookCompletion, runDueRetries } = await import('../../db/jobs')
        const id = await submitted(jobs, 'flaky-dockets', 30 * MINUTE)
        codebuild.builds.set((await row(id)).runner_ref!, {
            buildStatus: 'FAULT',
            endTime: new Date(Date.now() - 20 * MINUTE),
        })
        const sweptAt = new Date()

        expect(await jobs.sweep!(sweptAt)).toBe(1)
        const retry = await fakeDb
            .getDb()
            .selectFrom('jobs')
            .select(['id', 'status', 'attempt', 'run_after'])
            .where('retry_of', '=', id)
            .executeTakeFirstOrThrow()
        expect(retry).toMatchObject({ status: 'queued', attempt: 2 })
        expect(notified, 'the registry is asked; its notifier skips a failure that armed a retry').toEqual([id])

        // The tick starts attempt 2: a new build, recorded on the new row; its webhook completes it.
        expect(await runDueRetries(fakeDb, jobs, new Date(sweptAt.getTime() + 2 * MINUTE))).toMatchObject({
            started: 1,
        })
        expect(codebuild.started.at(-1)!.environmentVariablesOverride).toContainEqual({
            name: 'JOB_FIRST_ID',
            value: id,
            type: 'PLAINTEXT',
        })
        expect((await row(retry.id)).runner_ref).toMatch(/^proj:/)
        expect(await recordWebhookCompletion(fakeDb, { tenantId, jobId: retry.id, status: 'completed' })).toBe(
            'applied',
        )
        expect((await row(retry.id)).status).toBe('completed')
    })
})
