import { recordJobStatus } from '../../db/jobs'
import { InvalidTransitionError } from '../../core/state-machine'
import { type JobRunPorts, runJobInProcess } from '../../jobs/run-in-process'
import type { JobsPort } from '../../ports/jobs'

/** A terminal job's notification, as the registry gives it (`notifyJobTerminal`, with the request path's deps). */
export type NotifyJobTerminal = (input: {
    tenantId: string
    jobId: string
    status: 'completed' | 'failed'
}) => Promise<void>

/**
 * How long a handler may run before the runner fails its job: under the 30 seconds @sssb/cdk gives the server, so the
 * failure is recorded before the invocation is cut off.
 */
export const IN_PROCESS_DEADLINE_MS = 20_000

/**
 * A job still `running` this long after its last status change was lost: its invocation ended before the runner could
 * record an outcome (the server's time limit, a crash). Well past the deadline, so a job another invocation is still
 * running is never taken for lost.
 */
export const IN_PROCESS_LOST_AFTER_MS = 5 * 60_000

/**
 * The jobs port with no job compute of its own (`JOBS_RUNNER=in-process`, ./optional-ports.ts): `start` runs the job's
 * registered handler in the server, now, with the deployment's real ports, and records its terminal status before it
 * returns (`runJobInProcess`, which the simulated adapter runs too). No build project, no completion webhook: the
 * status is written where the work is done.
 *
 * `start` is called after the job's row has committed (`submitJob`, `runDueSchedules`), from the request that
 * submitted it or from the scheduled tick (`/api/webhooks/cron`), so a job shares that invocation's time limit with
 * whatever else it does, and a tick that spawns several runs them one after another. That is the limit of this runner:
 * work that may outrun it belongs on the CodeBuild runner. Two guards keep a job from being left `running`: a handler
 * that has not finished within `IN_PROCESS_DEADLINE_MS` fails its job, and `sweep`, which the scheduled tick calls,
 * fails a job still `running` `IN_PROCESS_LOST_AFTER_MS` after its last status change, as one whose invocation was cut
 * off before it could record anything.
 *
 * A terminal status notifies the job's org admins as the jobs webhook route does, through `notify`, which the adapter
 * registry passes in (it reaches the notification modules, which import the registry: this module must not). Best
 * effort: a failed notification is logged and never fails a job that already finished.
 */
export function createInProcessJobs(ports: JobRunPorts, notify: NotifyJobTerminal): JobsPort {
    const notifyBestEffort = async (tenantId: string, jobId: string, status: 'completed' | 'failed') => {
        try {
            await notify({ tenantId, jobId, status })
        } catch (error) {
            // console.warn reaches CloudWatch in Lambda; SSSB has no logger port (./db.ts does the same).
            console.warn(
                `SSSB jobs: job ${jobId} is ${status}, but notifying its org failed: ` +
                    (error instanceof Error ? error.message : String(error)),
            )
        }
    }
    return {
        async start(job) {
            await runJobInProcess(job, ports, (status) => notifyBestEffort(job.tenantId, job.id, status), {
                deadlineMs: IN_PROCESS_DEADLINE_MS,
            })
        },
        async sweep(now) {
            const before = new Date(now.getTime() - IN_PROCESS_LOST_AFTER_MS)
            const tenants = await ports.db.getDb().selectFrom('tenants').select('id').execute()
            let failed = 0
            for (const tenant of tenants) {
                const lost = await ports.db.withTenant(tenant.id, (trx) =>
                    trx
                        .selectFrom('jobs')
                        .select('id')
                        .where('status', '=', 'running')
                        .where('updated_at', '<', before.toISOString())
                        .execute(),
                )
                for (const { id } of lost) {
                    try {
                        await recordJobStatus(ports.db, tenant.id, id, 'failed', {
                            error: 'lost: the server stopped before the in-process runner recorded an outcome',
                        })
                    } catch (error) {
                        if (error instanceof InvalidTransitionError) continue // finished meanwhile
                        throw error
                    }
                    failed += 1
                    await notifyBestEffort(tenant.id, id, 'failed')
                }
            }
            return failed
        },
    }
}
