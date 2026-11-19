import { jobHandlers } from '@sssb/app-config/jobs'
import { isJobKind } from '../core/jobs'
import { InvalidTransitionError } from '../core/state-machine'
import { recordJobStatus } from '../db/jobs'
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
}

/**
 * Runs a submitted job to its terminal status in this process: claims it (queued -> running), runs the handler the
 * app's seam registers for its kind (`@sssb/app-config/jobs`), and records completed or failed. `recordJobStatus`
 * enforces the state machine, so the timeline is the one a CodeBuild run reports through the jobs webhook. Shared by
 * the simulated jobs adapter (../adapters/fake/jobs.ts) and the real in-process runner
 * (../adapters/real/jobs-in-process.ts), which differ only in the ports they pass and in how they notify.
 *
 * Returns false when another runner had already claimed the job (losing that race is benign, not an error), true once
 * this call has recorded the job's terminal status. A handler's error fails the job, never the caller; `notify` runs
 * after a terminal status is recorded, and its own failure is the caller's to contain. With `deadlineMs`, a handler
 * that has not settled by then fails the job ("timed out"); the handler is not stopped, and what it does afterwards
 * no longer changes the job's status.
 */
export async function runJobInProcess(
    job: SubmittedJob,
    ports: JobRunPorts,
    notify: (status: 'completed' | 'failed') => Promise<void>,
    options: { deadlineMs?: number } = {},
): Promise<boolean> {
    try {
        await recordJobStatus(ports.db, job.tenantId, job.id, 'running')
    } catch (error) {
        if (error instanceof InvalidTransitionError) return false
        throw error
    }
    if (!isJobKind(job.kind)) {
        await recordJobStatus(ports.db, job.tenantId, job.id, 'failed', { error: `unknown job kind: ${job.kind}` })
        return true
    }
    let status: 'completed' | 'failed'
    try {
        const handler = jobHandlers[job.kind]
        if (!handler) throw new Error(`no job handler registered for kind: ${job.kind}`)
        const run = handler(job.payload, { ...ports, tenantId: job.tenantId, orgId: job.orgId, jobId: job.id })
        const { resultKey } = await withDeadline(run, options.deadlineMs)
        await recordJobStatus(ports.db, job.tenantId, job.id, 'completed', { resultKey })
        status = 'completed'
    } catch (error) {
        await recordJobStatus(ports.db, job.tenantId, job.id, 'failed', {
            error: error instanceof Error ? error.message : String(error),
        })
        status = 'failed'
    }
    await notify(status)
    return true
}

/** `work`, or a rejection once `ms` have passed without it settling. No deadline when `ms` is undefined. */
async function withDeadline<T>(work: Promise<T>, ms: number | undefined): Promise<T> {
    if (ms === undefined) return work
    // A handler abandoned at the deadline may still reject later: handled here, or Node would end the process on an
    // unhandled rejection.
    work.catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000} seconds in the in-process runner`)), ms)
    })
    try {
        return await Promise.race([work, expired])
    } finally {
        clearTimeout(timer)
    }
}
