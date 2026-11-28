import type { Locale } from '../core/locale'
import type { AuthPort } from './auth'
import type { DbPort } from './db'
import type { EmailPort } from './email'
import type { LlmPort } from './llm'
import type { StoragePort } from './storage'

export interface SubmittedJob {
    id: string
    kind: string
    tenantId: string
    orgId: string | null
    payload: unknown
    /** Which attempt this is, from 1; absent means 1 (a submitted job, not a retry: safeinsights/sssb#135). */
    attempt?: number
    /** The first attempt's id, the key that stays the same across a job's retries; absent means `id`. */
    firstJobId?: string
}

/**
 * What a running job handler is given: the ports it may touch plus the job's tenant/org/id context.
 * The framework owns this contract; both framework handlers (packages/kit/src/jobs/digest-email.ts) and
 * app-registered handlers (the seam's src/app-config/jobs.ts) implement JobHandler against it.
 */
interface JobContext {
    db: DbPort
    storage: StoragePort
    /** For handlers that send mail (e.g. digest-email); the export handler ignores it. */
    email: EmailPort
    /**
     * For handlers whose work IS a model call — summarizing, classifying, extracting. Background work
     * is where an LLM call belongs (it is slow, it can fail, and its result is an artifact), so the
     * handler contract carries the port rather than making a handler reach for the adapter registry.
     */
    llm: LlmPort
    /**
     * For handlers that address people: who an org's members are, from the identity provider in a deployment (the
     * same `listMembers` the jobs' notifications use). A handler never reads people from the seed, which a real
     * deployment does not have.
     */
    auth: AuthPort
    /**
     * A person's own locale, by user id, where the runner knows it: the simulated world's runner does (its people's
     * profiles); a deployment's does not (the auth port carries none), so it is absent there and copy falls back to
     * the app's default, as the jobs' notifications do.
     */
    resolveLocale?: ((userId: string) => Locale | undefined) | undefined
    tenantId: string
    orgId: string | null
    jobId: string
    /**
     * Which attempt this run is, from 1. Above 1 only for a kind the seam's `jobRetry` lets retry: each attempt is a job
     * row of its own (`jobId` differs), and runs over whatever the failed attempt left behind, so such a handler must be
     * idempotent. SSSB's runners always set it and `firstJobId`; both are optional so that a test calling a handler
     * directly need not, and a handler reads an absent one as the first attempt.
     */
    attempt?: number
    /** The first attempt's job id, the same on every attempt: the key to deduplicate a retried handler's side effects on. */
    firstJobId?: string
}

export type JobHandler = (payload: unknown, ctx: JobContext) => Promise<{ resultKey?: string }>

/**
 * How much of the scheduled tick one `sweep` may spend (safeinsights/sssb#252): at most `maxItems` jobs failed, and
 * nothing started after `deadline` (in `clock`'s milliseconds, `Date.now` by default). `random` shuffles the order the
 * tenants (and a runner's own items within one) are looked at, so a bound that stops a sweep short does not always leave
 * the same ones for later. The shape of the drains' `DrainBudget` (packages/kit/src/db/drain-budget.ts), restated here
 * so the port imports nothing; the tick checks it as it checks theirs (`resolveDrainBudget`).
 */
export interface SweepBudget {
    maxItems: number
    deadline: number
    clock?: () => number
    random?: () => number
}

/**
 * Jobs port — the execution SEAM only. The `jobs` row, its status column, and the
 * `job_status_changes` timeline are app-owned in packages/kit/src/db/jobs.ts, where recordJobStatus is the
 * single choke point for every transition (state-machine guarded). This port just kicks the work
 * off: the fake adapter runs a registered handler in-process (instantly by default, or leaves the
 * job 'queued' when the simulated world is held); in real mode `JOBS_RUNNER` picks the runner:
 * `codebuild` starts a build whose terminal transition arrives later through the jobs webhook route,
 * `in-process` runs the handler in the server before `start` returns
 * (packages/kit/src/adapters/real/jobs-in-process.ts), and `none` throws `AbsentPortError`.
 */
export interface JobsPort {
    /**
     * Starts the job's work. A start that throws has started nothing, unless the error says otherwise: an error marked
     * `mayHaveStarted: true` (`mayHaveStarted` below) is one after which the work may be running all the same (a
     * timeout, a server fault), so a caller leaves the row as it is, `startingRef`, for the runner's sweep to judge
     * once the work has had time to report (safeinsights/sssb#251), rather than failing it and arming another attempt
     * beside it.
     */
    start(job: SubmittedJob): Promise<void>
    /**
     * Optional: for a runner whose jobs can be lost mid-run (the in-process runner, whose invocation can end before it
     * records an outcome; the CodeBuild runner, whose build can end without reporting), fails each job it judges lost
     * and says how many. The scheduled tick calls it, when the port has it, before it drains the due schedules, with a
     * budget of its own: a sweep stops judging once that is spent, and what it leaves the next tick's sweep finds.
     */
    sweep?(now: Date, budget?: SweepBudget): Promise<number>
    /**
     * Optional: the `jobs.runner_ref` a job's row is written with when this runner is the one to start it, so the row
     * says so from its first write (safeinsights/sssb#251). The CodeBuild runner's is `starting`, which its sweep can
     * judge even when `start` never gets as far as a write of its own. A runner without one leaves it null.
     */
    startingRef?: string
}

/**
 * Whether `start` threw an error after which the work may have started anyway (see `JobsPort.start`). Only meaningful
 * for a port with a `startingRef`: without one, nothing would ever judge a row left as it is.
 */
export function mayHaveStarted(error: unknown): boolean {
    return (
        typeof error === 'object' && error !== null && (error as { mayHaveStarted?: unknown }).mayHaveStarted === true
    )
}
