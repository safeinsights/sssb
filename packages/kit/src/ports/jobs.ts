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
    start(job: SubmittedJob): Promise<void>
    /**
     * Optional: for a runner whose jobs can be lost mid-run (the in-process runner, whose invocation can end before it
     * records an outcome), fails each job it judges lost and says how many. The scheduled tick calls it, when the port
     * has it, before it drains the due schedules.
     */
    sweep?(now: Date): Promise<number>
}
