import type { DbPort } from '../ports/db'
import type { NotifyJobTerminal } from './real/jobs-in-process'

/**
 * Fails one job a runner's sweep judged lost (the CodeBuild runner's, ./real/jobs.ts, safeinsights/sssb#231), and
 * notifies its end: `recordJobStatus`, which arms the next attempt of a kind whose `jobRetry` allows one, then `notify`,
 * which skips a failure that armed one. False when the job reached an end meanwhile (its webhook landed first, so the
 * state machine refuses the failure); a failure to notify is the notifier's to swallow.
 *
 * The adapter registry hands it to the real ports as `failLostJob`. The job modules are loaded when a job is failed,
 * never when this module is: the registry imports it while being evaluated, and the job modules reach the app's seam
 * and its handlers, which import the registry.
 */
export async function failLostJob(
    db: DbPort,
    notify: NotifyJobTerminal,
    input: { tenantId: string; jobId: string; error: string; now: Date },
): Promise<boolean> {
    const [{ recordJobStatus }, { InvalidTransitionError }] = await Promise.all([
        import('../db/jobs'),
        import('../core/state-machine'),
    ])
    try {
        await recordJobStatus(db, input.tenantId, input.jobId, 'failed', { error: input.error, now: input.now })
    } catch (error) {
        if (error instanceof InvalidTransitionError) return false
        throw error
    }
    await notify({ tenantId: input.tenantId, jobId: input.jobId, status: 'failed' })
    return true
}
