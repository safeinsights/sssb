import {
    BatchGetBuildsCommand,
    type BatchGetBuildsCommandOutput,
    CodeBuildClient,
    StartBuildCommand,
} from '@aws-sdk/client-codebuild'
import { shuffled } from '../../db/drain-budget'
import type { DbPort } from '../../ports/db'
import type { JobsPort, SubmittedJob } from '../../ports/jobs'

/**
 * Fails one job the sweep judged lost, and notifies its end: true when it was failed, false when it had reached an end
 * meanwhile (its webhook landed). The adapter registry supplies it (`recordJobStatus`, then `notifyJobTerminal`), so this
 * module, which the real ports load while the registry is still being evaluated, never imports the job modules, the
 * app's seam or its handlers (./index.ts, "What the adapter registry hands the real ports").
 */
export type FailLostJob = (input: { tenantId: string; jobId: string; error: string; now: Date }) => Promise<boolean>

/**
 * How long a CodeBuild job may sit unreported before the sweep judges it lost: after its build ENDED (time for the
 * build's final webhook to arrive), or after CodeBuild refused to start it (`refused`). Five minutes,
 * the scheduled tick's default period, so a webhook in flight is not taken for a lost one.
 */
export const CODEBUILD_LOST_AFTER_MS = 5 * 60_000

/**
 * The `runner_ref` a CodeBuild job's row is written with (this port's `startingRef`, in the row's own insert or claim:
 * safeinsights/sssb#251), replaced by the build's id once StartBuild returns.
 */
export const CODEBUILD_STARTING = 'starting'

/**
 * The `runner_ref` of a job whose StartBuild CodeBuild refused (a client fault: no permission, no such project, a
 * limit), so no build started: the sweep fails it after `CODEBUILD_LOST_AFTER_MS`, as it fails a build that ended.
 */
export const CODEBUILD_REFUSED = 'refused'

/**
 * How long a job may stay `starting` before the sweep takes its start for one that never reached CodeBuild: an hour.
 * Longer than `CODEBUILD_LOST_AFTER_MS` because the sweep cannot ask CodeBuild about a build it has no id for, and a
 * StartBuild that did start a build whose id went unrecorded (its response lost, the write refused) leaves a build
 * running; an hour lets most such builds report their own end first.
 */
export const CODEBUILD_STARTING_LOST_AFTER_MS = 60 * 60_000

/** BatchGetBuilds takes at most this many ids per call (the CodeBuild API reference). */
const BATCH_GET_BUILDS_MAX = 100

/** The build statuses that mean a build is over; IN_PROGRESS is the one that does not. */
const ENDED = new Set(['SUCCEEDED', 'FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT'])

/**
 * AUTHORED — CUTOVER (`job-runner`): typechecked against @aws-sdk/client-codebuild, never run
 * against a real project. Starting the build is ALL `start` does — the job stays 'queued' until
 * the build's FINAL step POSTs /api/webhooks/jobs with `x-sssb-webhook-secret: $WEBHOOK_SECRET` (never `Authorization`, which
 * the deployment's CloudFront replaces with its own signature) and
 * `{ jobId, tenantId, status: 'completed' | 'failed', resultKey?, error? }`, which records the
 * terminal transition via packages/kit/src/db/jobs.recordWebhookCompletion (idempotent under redelivery). The
 * build receives its context through environment overrides, mirroring a handler's `JobContext`: JOB_ID, JOB_KIND,
 * JOB_TENANT_ID, which the webhook echoes back as `tenantId` so the completion is scoped to the right tenant without the
 * build having to look it up, JOB_ORG_ID (empty for a job with no org), JOB_PAYLOAD, and JOB_ATTEMPT and JOB_FIRST_ID, a
 * handler's `ctx.attempt` and `ctx.firstJobId` (safeinsights/sssb#135): a kind that retries gets a new job, so a new
 * build, for each attempt, armed by the failed build's `failed` webhook. Every override is PLAINTEXT, readable in the
 * CodeBuild console and in CloudTrail, so a job's payload must never carry a secret or personal data: pass an id the
 * build reads with its own access instead.
 *
 * LOST BUILDS (safeinsights/sssb#231). The runner records the build behind the job in `jobs.runner_ref`: `starting` from
 * the row's own first write (this port's `startingRef`, which `submitJob`, a schedule's spawn and a retry's claim write
 * with the row, so no separate write can fail before StartBuild: safeinsights/sssb#251), then the build's id once
 * StartBuild returns. The scheduled tick calls `sweep`, which asks CodeBuild
 * (BatchGetBuilds, which the server's role must be allowed) about the runner's jobs still queued or running
 * and quiet for `CODEBUILD_LOST_AFTER_MS`, and fails as lost:
 *
 * - a job whose build ENDED (any status but IN_PROGRESS) at least that long ago without the job reaching an end: its
 *   webhook never came. A SUCCEEDED build counts: the job's result was never recorded.
 * - a job whose build CodeBuild has no record of (`buildsNotFound`).
 * - a job whose StartBuild CodeBuild refused (`refused`, a client fault), that long after.
 * - a job left `starting` for `CODEBUILD_STARTING_LOST_AFTER_MS` (an hour): its StartBuild never returned (or failed
 *   in a way that may have started a build), or the build's id was never recorded.
 *
 * A build still IN_PROGRESS is left alone, however long: CodeBuild's own timeout ends it, and a later sweep sees that.
 * Failing a lost job is `failLost`'s (the registry's: `recordJobStatus`, so a kind whose `jobRetry` has attempts left
 * gets its next attempt, then the job's end notified as the jobs webhook route's is). A job whose webhook lands between
 * the sweep's read and its write is already terminal, and the state machine refuses the failure. Without `failLost` (a
 * caller that builds the real ports itself) the runner has no sweep, as before. A job with no
 * `runner_ref` (written before the column existed, or held by another runner) is never judged. A sweep that cannot
 * reach CodeBuild (no permission, throttling) logs and fails nothing more; the tick carries on.
 *
 * THE BOUND (safeinsights/sssb#252). Given a budget, the sweep looks at the tenants, and at each tenant's builds, in a
 * fresh random order, and starts nothing (no tenant's listing, no BatchGetBuilds call, no failure) once it has failed
 * `maxItems` or its deadline has passed. It fails each loss as soon as it knows it: first the ones that need no
 * CodeBuild call (`refused`, and `starting` past the hour), then each BatchGetBuilds answer's before the next call, so
 * time spent reading never throws away a loss already found. A call already under way when the deadline passes runs to
 * its end (safeinsights/sssb#267).
 */
export function createRealJobs(project: string, region: string, db: DbPort, failLost?: FailLostJob): JobsPort {
    const client = new CodeBuildClient({ region })
    const startBuild = startBuildFor(project)

    const setRef = (tenantId: string, jobId: string, ref: string) =>
        db.withTenant(tenantId, (trx) =>
            trx.updateTable('jobs').set({ runner_ref: ref }).where('id', '=', jobId).execute(),
        )

    const port: JobsPort = {
        // Every job row this runner starts is written `starting` by its own insert (or the retry claim that readies it),
        // so there is no write of `start`'s own to fail before StartBuild (safeinsights/sssb#251).
        startingRef: CODEBUILD_STARTING,
        async start(job) {
            const started = await client.send(startBuild(job)).catch(async (error: unknown) => {
                // A client fault is CodeBuild saying no build started; anything else (a timeout, a server fault) may
                // have started one, so the job stays `starting` and gets the longer wait, and the error says so, so a
                // caller does not fail the job (and arm its next attempt) beside a build that may be running.
                if ((error as { $fault?: unknown }).$fault === 'client') {
                    await setRef(job.tenantId, job.id, CODEBUILD_REFUSED).catch(() => undefined)
                    throw error
                }
                throw markMayHaveStarted(error)
            })
            const buildId = started.build?.id
            if (!buildId) {
                // Left `starting`: the sweep fails it as lost once CODEBUILD_STARTING_LOST_AFTER_MS has passed.
                console.warn(`SSSB jobs: CodeBuild started job ${job.id} but returned no build id`)
                return
            }
            try {
                await setRef(job.tenantId, job.id, buildId)
            } catch (error) {
                // The build runs; only its id is unrecorded, so the sweep will take the job for one that never started.
                console.warn(
                    `SSSB jobs: job ${job.id} started build ${buildId}, but recording it failed: ${messageOf(error)}`,
                )
            }
        },
    }
    if (!failLost) return port
    return {
        ...port,
        async sweep(now, budget) {
            const quietSince = new Date(now.getTime() - CODEBUILD_LOST_AFTER_MS)
            let failed = 0
            // Bounded by the tick's budget (safeinsights/sssb#252): no tenant looked at, no build asked about and no job
            // failed after its deadline, and no more failed than its count.
            const clock = budget?.clock ?? Date.now
            const spent = () => budget !== undefined && (failed >= budget.maxItems || clock() >= budget.deadline)
            let tenants: { id: string }[]
            try {
                tenants = await db.getDb().selectFrom('tenants').select('id').execute()
            } catch (error) {
                console.warn(`SSSB jobs: the CodeBuild sweep could not list tenants: ${messageOf(error)}`)
                return 0
            }
            // In a fresh random order under a bound, so a sweep it stops short does not always leave the same tenants.
            for (const tenant of budget ? shuffled(tenants, budget, (t) => t.id) : tenants) {
                if (spent()) break
                let open: { id: string; runner_ref: string | null; updated_at: unknown }[]
                try {
                    open = await db.withTenant(tenant.id, (trx) =>
                        trx
                            .selectFrom('jobs')
                            .select(['id', 'runner_ref', 'updated_at'])
                            .where('status', 'in', ['queued', 'running'])
                            .where('runner_ref', 'is not', null)
                            .where('updated_at', '<', quietSince.toISOString())
                            .execute(),
                    )
                } catch (error) {
                    console.warn(`SSSB jobs: the CodeBuild sweep skipped tenant ${tenant.id}: ${messageOf(error)}`)
                    continue
                }
                // Each loss is failed as soon as it is known, so time a slow read phase spends never throws away work
                // already found: first the losses that need no CodeBuild call, then each batch's as it is read.
                const failAll = async (lost: { id: string; error: string }[]) => {
                    for (const { id, error } of lost) {
                        if (spent()) return
                        try {
                            if (await failLost({ tenantId: tenant.id, jobId: id, error, now })) failed += 1
                        } catch (failure) {
                            console.warn(
                                `SSSB jobs: the CodeBuild sweep could not fail job ${id}: ${messageOf(failure)}`,
                            )
                        }
                    }
                }
                await failAll([
                    ...open
                        .filter((job) => job.runner_ref === CODEBUILD_REFUSED)
                        .map((job) => ({ id: job.id, error: 'lost: CodeBuild refused to start its build' })),
                    ...open
                        .filter(
                            (job) =>
                                job.runner_ref === CODEBUILD_STARTING &&
                                new Date(job.updated_at as string | Date).getTime() <
                                    now.getTime() - CODEBUILD_STARTING_LOST_AFTER_MS,
                        )
                        .map((job) => ({
                            id: job.id,
                            error: 'lost: its CodeBuild build was never recorded as started',
                        })),
                ])
                const byBuild = new Map<string, string>()
                for (const job of open) {
                    if (
                        job.runner_ref &&
                        job.runner_ref !== CODEBUILD_STARTING &&
                        job.runner_ref !== CODEBUILD_REFUSED
                    ) {
                        byBuild.set(job.runner_ref, job.id)
                    }
                }
                // Under a bound the builds are asked about in a fresh random order too, so a tenant with more builds than
                // one window can read has a different part of them read each tick, not always the first.
                const ids = budget ? shuffled([...byBuild.keys()], budget, (id) => id) : [...byBuild.keys()]
                for (let i = 0; i < ids.length; i += BATCH_GET_BUILDS_MAX) {
                    if (spent()) break
                    let answer: BatchGetBuildsCommandOutput
                    try {
                        answer = await client.send(
                            new BatchGetBuildsCommand({ ids: ids.slice(i, i + BATCH_GET_BUILDS_MAX) }),
                        )
                    } catch (error) {
                        // No permission, throttling, an outage: judge no build rather than guess.
                        console.warn(`SSSB jobs: the CodeBuild sweep could not read builds: ${messageOf(error)}`)
                        break
                    }
                    const lost: { id: string; error: string }[] = []
                    for (const build of answer.builds ?? []) {
                        const jobId = build.id === undefined ? undefined : byBuild.get(build.id)
                        if (!jobId || !build.buildStatus || !ENDED.has(build.buildStatus)) continue
                        // Ended, but recently: its webhook may still be on its way.
                        if (build.endTime && build.endTime.getTime() > quietSince.getTime()) continue
                        lost.push({
                            id: jobId,
                            error: `lost: its CodeBuild build ended ${build.buildStatus} without reporting the job's end`,
                        })
                    }
                    for (const missing of answer.buildsNotFound ?? []) {
                        const jobId = byBuild.get(missing)
                        if (jobId) lost.push({ id: jobId, error: 'lost: CodeBuild has no record of its build' })
                    }
                    await failAll(lost)
                }
            }
            return failed
        },
    }
}

/** `error`, marked as one after which a build may have started (`mayHaveStarted`, ../../ports/jobs.ts). */
function markMayHaveStarted(error: unknown): Error {
    const marked = error instanceof Error ? error : new Error(String(error))
    return Object.assign(marked, { mayHaveStarted: true })
}

/** The StartBuild call for `job`: the project, and the job's context as the build's environment. */
function startBuildFor(project: string) {
    return (job: SubmittedJob) =>
        new StartBuildCommand({
            projectName: project,
            environmentVariablesOverride: [
                { name: 'JOB_ID', value: job.id, type: 'PLAINTEXT' },
                { name: 'JOB_KIND', value: job.kind, type: 'PLAINTEXT' },
                { name: 'JOB_TENANT_ID', value: job.tenantId, type: 'PLAINTEXT' },
                { name: 'JOB_ORG_ID', value: job.orgId ?? '', type: 'PLAINTEXT' },
                { name: 'JOB_PAYLOAD', value: JSON.stringify(job.payload ?? {}), type: 'PLAINTEXT' },
                { name: 'JOB_ATTEMPT', value: String(job.attempt ?? 1), type: 'PLAINTEXT' },
                { name: 'JOB_FIRST_ID', value: job.firstJobId ?? job.id, type: 'PLAINTEXT' },
            ],
        })
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
