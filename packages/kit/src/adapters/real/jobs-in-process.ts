import { InvalidTransitionError } from '../../core/state-machine'
import { recordJobStatus } from '../../db/jobs'
import { type JobRunPorts, runJobInProcess } from '../../jobs/run-in-process'
import type { JobsPort } from '../../ports/jobs'

/** A terminal job's notification, as the adapter registry gives it (`notifyJobTerminal`, with the request path's deps). */
export type NotifyJobTerminal = (input: {
    tenantId: string
    jobId: string
    status: 'completed' | 'failed'
}) => Promise<void>

/** The message on the `running` timeline entry of a job this runner claimed: how `sweep` knows its own jobs. */
export const IN_PROCESS_CLAIM = 'claimed by the in-process runner'

/**
 * A job this runner claimed that is still `running` this long after its last status change was lost: the invocation
 * that ran it ended (the server's time limit, a crash) before the runner could record an outcome. Many times the
 * 30 seconds @sssb/cdk gives the server, so a job another invocation is still running is not taken for lost there.
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
 * work that may outrun it belongs on the CodeBuild runner. A job cut off by the limit is left `running`: the
 * invocation is ended with its process, so the job's open transaction rolls back (at once on `pg`; on the Data API
 * when that transaction times out), and `sweep`, which the scheduled tick calls, fails it once
 * `IN_PROCESS_LOST_AFTER_MS` have passed. Only jobs this runner claimed (`IN_PROCESS_CLAIM`) are swept, so a job
 * another runner holds `running` (a service caller's, through its status route, or one the jobs webhook is walking
 * to its end) is left to it.
 *
 * The sweep also fails a job still `queued` after `IN_PROCESS_LOST_AFTER_MS`: its row committed but `start` never
 * claimed it (the invocation ended between the two, the runner failed to load, the request's `start` threw). A queued
 * job carries no claim, so age alone decides, and that is sound for this runner only: with `JOBS_RUNNER=in-process`
 * every job is this runner's, and `start` claims it in the invocation that committed it, within that invocation's
 * 30-second limit, so a job queued for minutes will never start. It is failed, never run: a handler is written to run
 * at most once, and the request or tick that submitted it may have reported it already. The CodeBuild runner has no
 * sweep (a build may wait in CodeBuild's own queue), and neither does the simulated world, whose held jobs stay
 * `queued` on purpose.
 *
 * Retries (safeinsights/sssb#135). A retry still waiting out its delay (`queued` with `run_after` set) is the
 * scheduled tick's to start, so the sweep leaves it alone; once the tick claims it (`run_after` cleared, `updated_at`
 * set to the claim) it is judged as any queued job. A lost job of a kind whose `jobRetry` has attempts left is failed
 * like any other, and `recordJobStatus` arms its next attempt, a new job: the work does run again, as that attempt,
 * which is why a kind that retries must be idempotent.
 *
 * A terminal status notifies the job's org admins as the jobs webhook route does, through `notify`, which the adapter
 * registry passes in (the notification modules import the registry). Best effort: `notifyJobTerminal` swallows its
 * own failures, and anything else `notify` throws is logged; neither fails a job that already finished.
 */
export function createInProcessJobs(ports: JobRunPorts, notify: NotifyJobTerminal): JobsPort {
    const notifyBestEffort = async (tenantId: string, jobId: string, status: 'completed' | 'failed') => {
        try {
            await notify({ tenantId, jobId, status })
        } catch (error) {
            // console.warn reaches CloudWatch in Lambda; SSSB has no logger port (./db.ts does the same).
            console.warn(`SSSB jobs: job ${jobId} is ${status}, but notifying its org failed: ${messageOf(error)}`)
        }
    }
    return {
        async start(job) {
            await runJobInProcess(job, ports, (status) => notifyBestEffort(job.tenantId, job.id, status), {
                claimMessage: IN_PROCESS_CLAIM,
            })
        },
        // Fault-isolated per tenant and per job, as `runDueSchedules` is per schedule: one failure is logged and the
        // sweep goes on, and nothing it throws reaches the tick.
        async sweep(now) {
            const before = new Date(now.getTime() - IN_PROCESS_LOST_AFTER_MS).toISOString()
            let failed = 0
            let tenants: { id: string }[]
            try {
                tenants = await ports.db.getDb().selectFrom('tenants').select('id').execute()
            } catch (error) {
                console.warn(`SSSB jobs: the in-process sweep could not list tenants: ${messageOf(error)}`)
                return 0
            }
            for (const tenant of tenants) {
                let lost: { id: string; status: string }[]
                try {
                    lost = await ports.db.withTenant(tenant.id, (trx) =>
                        trx
                            .selectFrom('jobs')
                            .select(['jobs.id', 'jobs.status'])
                            .where('jobs.updated_at', '<', before)
                            .where((eb) =>
                                eb.or([
                                    // A retry waiting out its backoff is the tick's to start, not lost (its run_after is
                                    // cleared when the tick claims it, and from then on it is judged as any queued job).
                                    eb.and([eb('jobs.status', '=', 'queued'), eb('jobs.run_after', 'is', null)]),
                                    eb.and([
                                        eb('jobs.status', '=', 'running'),
                                        eb.exists(
                                            eb
                                                .selectFrom('job_status_changes')
                                                .select('job_status_changes.id')
                                                .whereRef('job_status_changes.job_id', '=', 'jobs.id')
                                                .where('job_status_changes.status', '=', 'running')
                                                .where('job_status_changes.message', '=', IN_PROCESS_CLAIM),
                                        ),
                                    ]),
                                ]),
                            )
                            .execute(),
                    )
                } catch (error) {
                    console.warn(`SSSB jobs: the in-process sweep skipped tenant ${tenant.id}: ${messageOf(error)}`)
                    continue
                }
                for (const { id, status } of lost) {
                    try {
                        await recordJobStatus(ports.db, tenant.id, id, 'failed', {
                            now,
                            error:
                                status === 'queued'
                                    ? 'lost: never started; the in-process runner did not claim it'
                                    : 'lost: the server stopped before the in-process runner recorded an outcome',
                        })
                    } catch (error) {
                        if (!(error instanceof InvalidTransitionError)) {
                            console.warn(
                                `SSSB jobs: the in-process sweep could not fail job ${id}: ${messageOf(error)}`,
                            )
                        }
                        continue // InvalidTransitionError: it started or finished, or another sweep failed it, meanwhile
                    }
                    failed += 1
                    await notifyBestEffort(tenant.id, id, 'failed')
                }
            }
            return failed
        },
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
