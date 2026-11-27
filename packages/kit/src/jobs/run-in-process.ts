import { jobHandlers } from '@sssb/app-config/jobs'
import { isJobKind } from '../core/jobs'
import { InvalidTransitionError } from '../core/state-machine'
import { recordJobStatus } from '../db/jobs'
import type { Locale } from '../core/locale'
import type { AuthPort } from '../ports/auth'
import type { DbPort } from '../ports/db'
import type { EmailPort } from '../ports/email'
import type { SubmittedJob } from '../ports/jobs'
import type { LlmPort } from '../ports/llm'
import type { StoragePort } from '../ports/storage'

/** The ports a job's handler runs with (its `JobContext`, less the job's own ids). */
export interface JobRunPorts {
    db: DbPort
    storage: StoragePort
    email: EmailPort
    llm: LlmPort
    auth: AuthPort
    resolveLocale?: ((userId: string) => Locale | undefined) | undefined
    /**
     * The clock a failure's retry delay is measured from: the simulated world's (so a demo whose clock was moved reaches
     * the retry by moving it again), else the real one.
     */
    now?: (() => Date) | undefined
}

/**
 * Runs a submitted job to its terminal status in this process: claims it (queued -> running), runs the handler the
 * app's seam registers for its kind (`@sssb/app-config/jobs`), and records completed or failed. `recordJobStatus`
 * enforces the state machine, so the timeline is the one a CodeBuild run reports through the jobs webhook. Shared by
 * the simulated jobs adapter (../adapters/fake/jobs.ts) and the real in-process runner
 * (../adapters/real/jobs-in-process.ts), which differ in the ports they pass, in how they notify, and in the real runner's claim message.
 *
 * Returns false when another runner had already claimed the job (losing that race is benign, not an error), true once
 * this call has recorded the job's terminal status. A handler's error fails the job, never the caller; `notify` runs
 * after a terminal status is recorded, and its own failure is the caller's to contain. `claimMessage` is written on the
 * job's `running` timeline entry, so a runner can later tell the jobs it claimed from another runner's.
 */
export async function runJobInProcess(
    job: SubmittedJob,
    ports: JobRunPorts,
    notify: (status: 'completed' | 'failed') => Promise<void>,
    options: { claimMessage?: string } = {},
): Promise<boolean> {
    try {
        await recordJobStatus(
            ports.db,
            job.tenantId,
            job.id,
            'running',
            options.claimMessage === undefined ? undefined : { message: options.claimMessage },
        )
    } catch (error) {
        if (error instanceof InvalidTransitionError) return false
        throw error
    }
    if (!isJobKind(job.kind)) {
        // An unknown kind retries nothing: `jobRetry` names only registered kinds.
        await recordJobStatus(ports.db, job.tenantId, job.id, 'failed', { error: `unknown job kind: ${job.kind}` })
        return true
    }
    // Only the handler's own failure fails the job. Recording the outcome stays outside: a failure there (say, after
    // `completed` has committed) must not be answered by recording `failed` over it, which the state machine refuses.
    let outcome: { status: 'completed'; resultKey: string | undefined } | { status: 'failed'; error: string }
    try {
        const handler = jobHandlers[job.kind]
        if (!handler) throw new Error(`no job handler registered for kind: ${job.kind}`)
        const { resultKey } = await handler(job.payload, {
            ...ports,
            tenantId: job.tenantId,
            orgId: job.orgId,
            jobId: job.id,
            attempt: job.attempt ?? 1,
            firstJobId: job.firstJobId ?? job.id,
        })
        outcome = { status: 'completed', resultKey }
    } catch (error) {
        outcome = { status: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
    const now = ports.now?.()
    await recordJobStatus(
        ports.db,
        job.tenantId,
        job.id,
        outcome.status,
        outcome.status === 'completed'
            ? { resultKey: outcome.resultKey }
            : { error: outcome.error, ...(now && { now }) },
    )
    await notify(outcome.status)
    return true
}
