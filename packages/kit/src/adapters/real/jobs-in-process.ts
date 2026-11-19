import type { AuthPort } from '../../ports/auth'
import type { JobsPort, SubmittedJob } from '../../ports/jobs'
import { type JobRunPorts, runJobInProcess } from '../../jobs/run-in-process'

/**
 * The jobs port with no job compute of its own (`JOBS_RUNNER=in-process`, ./optional-ports.ts): `start` runs the job's
 * registered handler in the server, now, with the deployment's real ports, and records its terminal status before it
 * returns (`runJobInProcess`, which the simulated adapter runs too). No build project, no completion webhook: the
 * status is written where the work is done.
 *
 * `start` is called after the job's row has committed (`submitJob`, `runDueSchedules`), from the request that
 * submitted it or from the scheduled tick (`/api/webhooks/cron`). So a job shares that invocation's time limit (30
 * seconds for @sssb/cdk's server) with whatever else the request does, and a tick that spawns several runs them one
 * after another. That is the limit of this runner: work that may outrun it belongs on the CodeBuild runner.
 *
 * A terminal status notifies the job's org admins as the jobs webhook route does (`notifyJobTerminal`), best-effort: a
 * failed notification is logged and never fails a job that already finished. The notification modules are imported
 * when a job ends, never statically, because they import the adapter registry, which builds this runner while it loads.
 */
export function createInProcessJobs(ports: JobRunPorts & { auth: AuthPort }): JobsPort {
    const { auth, ...runPorts } = ports
    return {
        async start(job) {
            await runJobInProcess(job, runPorts, (status) => notifyTerminal(auth, job, status))
        },
    }
}

async function notifyTerminal(auth: AuthPort, job: SubmittedJob, status: 'completed' | 'failed'): Promise<void> {
    try {
        const { notifyJobTerminal } = await import('../../server-lib/notify')
        const { makeNotifyDeps } = await import('../../server-lib/notify-deps')
        await notifyJobTerminal(await makeNotifyDeps(), auth, { tenantId: job.tenantId, jobId: job.id, status })
    } catch (error) {
        // console.warn reaches CloudWatch in Lambda; SSSB has no logger port (./db.ts does the same).
        console.warn(
            `SSSB jobs: job ${job.id} is ${status}, but notifying its org failed: ` +
                (error instanceof Error ? error.message : String(error)),
        )
    }
}
