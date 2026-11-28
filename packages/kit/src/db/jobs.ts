import type { Kysely, Transaction } from 'kysely'
import { exportKeyPrefix, jobRetryFor, type JobStatus, jobStatusMachine, retryDelayMs } from '../core/jobs'
import { InvalidTransitionError } from '../core/state-machine'
import type { DbPort } from '../ports/db'
import { NotFoundError } from '../ports/errors'
import { type JobsPort, mayHaveStarted } from '../ports/jobs'
import {
    beforeDeadline,
    type DrainBudget,
    type DrainLeft,
    drainFairly,
    listingLimit,
    resolveDrainBudget,
} from './drain-budget'
import { family } from './family'
import type { DB } from './schema'
import { enqueueWebhookEvent } from './webhooks'

export interface JobTimelineEntry {
    status: JobStatus
    message: string | null
    at: string
}

export interface JobView {
    id: string
    kind: string
    status: JobStatus
    createdAt: string
    resultKey: string | null
    error: string | null
    /**
     * Which attempt this row is, from 1; a kind that retries runs each attempt as a row of its own. Always set by
     * `listJobs`; optional so that a story or test building a view by hand need not.
     */
    attempt?: number
    /** The first attempt's id, on a retry; null on attempt 1. Always set by `listJobs`. */
    retryOf?: string | null
    timeline: JobTimelineEntry[]
}

/** timestamptz comes back from both pglite and real Postgres as a Date; views expose ISO strings. */
export function toIso(value: unknown): string {
    return value instanceof Date ? value.toISOString() : String(value)
}

/**
 * Submits a job: one tenant-scoped transaction persists the `jobs` row and its opening 'queued'
 * timeline entry together, THEN — only once that has committed — hands off to the execution seam
 * so the handler (fake: in-process; real: CodeBuild) can never observe a job that isn't durable yet.
 * `requestedBy` is the user id of the person submitting it, when a person is: their job's end reaches them when
 * the org has no admin to tell (../server-lib/notify.ts `notifyJobTerminal`).
 */
export async function submitJob(
    db: DbPort,
    jobs: JobsPort,
    input: { tenantId: string; orgId: string | null; kind: string; payload: unknown; requestedBy?: string | null },
): Promise<{ id: string }> {
    const { id } = await db.withTenant(input.tenantId, async (trx) => {
        const job = await trx
            .insertInto('jobs')
            .values({
                tenant_id: input.tenantId,
                org_id: input.orgId,
                kind: input.kind,
                payload: input.payload,
                requested_by: input.requestedBy ?? null,
                // The runner's starting ref, in the same insert, so no separate write can fail between the two (#251).
                runner_ref: jobs.startingRef ?? null,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        await trx
            .insertInto('job_status_changes')
            .values({ tenant_id: input.tenantId, job_id: job.id, status: 'queued', message: null })
            .execute()
        return job
    })
    await jobs.start({ id, kind: input.kind, tenantId: input.tenantId, orgId: input.orgId, payload: input.payload })
    return { id }
}

/** A retry `recordJobStatus` armed: the next attempt's row, queued until `runAfter`. */
export interface ArmedRetry {
    jobId: string
    attempt: number
    attempts: number
    runAfter: Date
}

/**
 * THE choke point for every status change. One tenant-scoped transaction locks the job row
 * (FOR UPDATE — concurrent transitions for the same job serialize instead of double-writing under
 * pooled Postgres, e.g. a webhook redelivery), asserts the hop is legal (a bad transition throws
 * InvalidTransitionError and rolls back), updates the job row, and appends an immutable timeline
 * entry. Callers racing to *start* a job should treat InvalidTransitionError as "someone else
 * already did" — see the fake executor.
 *
 * RETRIES (safeinsights/sssb#135). A hop to `failed` of a kind whose `jobRetry` setting has attempts left also inserts,
 * in the SAME transaction, the next attempt as a new row: queued, `run_after` the failure plus the kind's delay
 * (`extra.now`, else the real clock, is when it failed), the same kind, org, payload and requester, `retry_of` naming the
 * first attempt. Its opening timeline entry says which attempt it is and the error it follows; the failed entry says a
 * retry was armed. So the failed row stays terminal, a redelivered failure (the row is already `failed`) arms nothing
 * more, and the attempt is never lost between the failure and the retry. The scheduled tick's `runDueRetries` starts it.
 * Returns the retry it armed, or null.
 */
export async function recordJobStatus(
    db: DbPort,
    tenantId: string,
    jobId: string,
    next: JobStatus,
    extra?: { message?: string; resultKey?: string | undefined; error?: string | undefined; now?: Date },
): Promise<{ retry: ArmedRetry | null }> {
    const job = await db.withTenant(tenantId, async (trx) => {
        const current = await trx
            .selectFrom('jobs')
            .select(['status', 'org_id', 'kind', 'attempt', 'retry_of', 'payload', 'requested_by'])
            .where('id', '=', jobId)
            .$call(family.lockRow)
            .executeTakeFirstOrThrow()
        jobStatusMachine.assertTransition(current.status as JobStatus, next)
        const policy = jobRetryFor(current.kind)
        const retry: Omit<ArmedRetry, 'jobId'> | null =
            next === 'failed' && current.attempt < policy.attempts
                ? {
                      attempt: current.attempt + 1,
                      attempts: policy.attempts,
                      runAfter: new Date((extra?.now ?? new Date()).getTime() + retryDelayMs(policy, current.attempt)),
                  }
                : null
        await trx
            .updateTable('jobs')
            .set({
                status: next,
                updated_at: family.currentTime(),
                // A hop out of `queued` ends any wait: a retry some other path reached first (a service caller, a
                // webhook) is no longer one the retry drain should list.
                ...(current.status === 'queued' ? { run_after: null } : {}),
                ...(extra?.resultKey !== undefined ? { result_key: extra.resultKey } : {}),
                ...(extra?.error !== undefined ? { error: extra.error } : {}),
            })
            .where('id', '=', jobId)
            .execute()
        const armedNote = retry
            ? `retry armed: attempt ${retry.attempt} of ${retry.attempts} at ${retry.runAfter.toISOString()}`
            : null
        await trx
            .insertInto('job_status_changes')
            .values({
                tenant_id: tenantId,
                job_id: jobId,
                status: next,
                message: [extra?.message, armedNote].filter((part) => part).join('; ') || null,
            })
            .execute()
        if (!retry) return { orgId: current.org_id, kind: current.kind, retry: null }
        const nextAttempt = await trx
            .insertInto('jobs')
            .values({
                tenant_id: tenantId,
                org_id: current.org_id,
                kind: current.kind,
                payload: current.payload,
                requested_by: current.requested_by,
                attempt: retry.attempt,
                retry_of: current.retry_of ?? jobId,
                run_after: retry.runAfter,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        await trx
            .insertInto('job_status_changes')
            .values({
                tenant_id: tenantId,
                job_id: nextAttempt.id,
                status: 'queued',
                message: `attempt ${retry.attempt} of ${retry.attempts}, after: ${extra?.error ?? 'failed'}`,
            })
            .execute()
        return { orgId: current.org_id, kind: current.kind, retry: { ...retry, jobId: nextAttempt.id } }
    })

    // Outbound webhooks: a job status change is an emitted event. Enqueue only — cheap; the
    // drain delivers async. Deliberately AFTER the status transaction commits (the audit precedent),
    // and skipped when the job has no org (RLS-proof / legacy rows can't have subscribed endpoints).
    // The status is durable by now, so a failed enqueue must not fail the caller: a runner that saw
    // `running` throw would never run the handler, and one that saw `completed` throw would answer an
    // error for a job that finished. The event is lost and logged (console.warn reaches CloudWatch in
    // Lambda; SSSB has no logger port, as ../adapters/real/db.ts says).
    if (job.orgId) {
        try {
            await enqueueWebhookEvent(db, {
                tenantId,
                orgId: job.orgId,
                kind: 'job.status_changed',
                payload: { jobId, jobKind: job.kind, status: next, orgId: job.orgId },
            })
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.warn(`SSSB jobs: job ${jobId} is ${next}, but enqueueing its webhook event failed: ${message}`)
        }
    }
    return { retry: job.retry }
}

/**
 * THE retry drain (safeinsights/sssb#135), the scheduled tick's third, beside the schedules' and the deliveries'. Finds
 * every retry whose backoff has run out (`queued`, `run_after` at or before `now`), per tenant under `withTenant` as the
 * other drains do, and for each: CLAIMS it in a row-locked transaction (re-checks it is still waiting and due, then
 * clears `run_after`, after which it is an ordinary queued job, exactly as `submitJob` leaves one), and only after that
 * commits hands it to the jobs port with its attempt and first attempt's id. A second tick racing the same row blocks
 * on the lock and then sees nothing to claim, so a retry is started once. A start that throws records the attempt
 * failed with the runner's error, which arms the next attempt when there is one; a start that never reached the runner
 * (the invocation ended between the claim and the start) leaves a queued job like any other, which the in-process
 * runner's sweep fails as lost, again arming the next attempt.
 *
 * `onFailed` is called after a start that threw has been recorded failed, so the caller can notify the job's end as
 * every runner does (the scheduled tick and the Simulator pass `notifyRetryEnd`, ../server-lib/scheduled-tick.ts, which
 * calls `notifyJobTerminal`; this module cannot import the notifier).
 *
 * BOUND (./drain-budget.ts): with a budget, at most `budget.maxItems` starts, none after its deadline, one tenant's
 * retry at a time in turn; a due retry left over is not claimed and the next tick lists it again. Without a budget it
 * starts every due retry. Returns how many it started, how many failed to start, and what it left.
 */
export async function runDueRetries(
    db: DbPort,
    jobs: JobsPort,
    now: Date,
    budget?: DrainBudget,
    onFailed?: (input: { tenantId: string; jobId: string }) => Promise<void>,
): Promise<{ started: number; failed: number } & DrainLeft> {
    const limit = resolveDrainBudget(budget)
    let started = 0
    let failed = 0
    if (!beforeDeadline(limit)) return { started, failed, deferred: 0, stoppedBy: 'time' }
    await db.ready()
    const tenants = await db.getDb().selectFrom('tenants').select('id').execute()
    const perTenant = listingLimit(limit)
    const left = await drainFairly(
        tenants,
        limit,
        (tenantId) =>
            db.withTenant(tenantId, (trx) =>
                trx
                    .selectFrom('jobs')
                    .select('id')
                    .where('status', '=', 'queued')
                    .where('run_after', 'is not', null)
                    .where('run_after', '<=', now)
                    .orderBy('run_after', 'asc')
                    .orderBy('id', 'asc')
                    .$if(perTenant !== null, (qb) => qb.limit(perTenant ?? 0))
                    .execute(),
            ),
        (row) => row.id,
        async (row, tenantId) => {
            try {
                if (await startRetry(db, jobs, now, tenantId, row.id, onFailed)) started += 1
            } catch {
                // A bad row must not stall the rest (the runDueSchedules fault-isolation precedent).
                failed += 1
            }
        },
    )
    return { started, failed, ...left }
}

/** Claims one due retry and starts it; false when the under-lock re-check finds nothing to claim. */
async function startRetry(
    db: DbPort,
    jobs: JobsPort,
    now: Date,
    tenantId: string,
    jobId: string,
    onFailed: ((input: { tenantId: string; jobId: string }) => Promise<void>) | undefined,
): Promise<boolean> {
    const claimed = await db.withTenant(tenantId, async (trx) => {
        const row = await trx
            .selectFrom('jobs')
            .select(['status', 'kind', 'org_id', 'payload', 'attempt', 'retry_of', 'run_after'])
            .where('id', '=', jobId)
            .$call(family.lockRow)
            .executeTakeFirst()
        if (!row || row.status !== 'queued' || row.run_after === null || new Date(row.run_after) > now) return null
        await trx
            .updateTable('jobs')
            .set({ run_after: null, runner_ref: jobs.startingRef ?? null, updated_at: family.currentTime() })
            .where('id', '=', jobId)
            .execute()
        return row
    })
    if (!claimed) return false
    try {
        await jobs.start({
            id: jobId,
            kind: claimed.kind,
            tenantId,
            orgId: claimed.org_id,
            payload: claimed.payload,
            attempt: claimed.attempt,
            firstJobId: claimed.retry_of ?? jobId,
        })
    } catch (error) {
        // A start that may have started the work anyway (a timeout, a server fault) leaves the claimed row as it is,
        // `startingRef`, for the runner's sweep to judge, as `submitJob` and a schedule's spawn do: failing it here
        // would arm the next attempt beside a build that may be running, and drop that build's result.
        if (jobs.startingRef !== undefined && mayHaveStarted(error)) throw error
        // The runner refused it (CodeBuild's StartBuild refused, say): this attempt failed, which arms the next one.
        await recordJobStatus(db, tenantId, jobId, 'failed', {
            error: `the jobs runner did not start it: ${error instanceof Error ? error.message : String(error)}`,
            now,
        })
        // The end of the job when no attempt is left, which the notifier tells apart (a failure that armed one is not).
        await onFailed?.({ tenantId, jobId })
        throw error
    }
    return true
}

/**
 * Lists a team's jobs newest-first, each with its full timeline embedded (two queries, one
 * transaction). Org-filtered — the team collaboration boundary, an app-level WHERE on top of the
 * tenant RLS scope (the same shape an app’s own list route has).
 */
export async function listJobs(
    db: DbPort,
    tenantId: string,
    orgId: string,
    opts?: { kind?: string; limit?: number },
): Promise<JobView[]> {
    const limit = opts?.limit ?? 20
    return db.withTenant(tenantId, async (trx) => {
        const rows = await trx
            .selectFrom('jobs')
            .select(['id', 'kind', 'status', 'result_key', 'error', 'attempt', 'retry_of', 'created_at'])
            .where('org_id', '=', orgId)
            .$if(opts?.kind !== undefined, (qb) => qb.where('kind', '=', opts!.kind!))
            .orderBy('created_at', 'desc')
            .limit(limit)
            .execute()
        if (rows.length === 0) return []
        const timelines = await loadTimelines(
            trx,
            rows.map((r) => r.id),
        )
        return rows.map((r) => ({
            id: r.id,
            kind: r.kind,
            status: r.status as JobStatus,
            createdAt: toIso(r.created_at),
            resultKey: r.result_key,
            error: r.error,
            attempt: r.attempt,
            retryOf: r.retry_of,
            timeline: timelines.get(r.id) ?? [],
        }))
    })
}

/** A job as an external service caller sees it: no timeline (polling stays light), payload included. */
export interface ServiceJobView {
    id: string
    kind: string
    status: JobStatus
    payload: unknown
    createdAt: string
    resultKey: string | null
    error: string | null
    /** Which attempt this row is, from 1. Always set by `listServiceJobs`; optional as on `JobView`. */
    attempt?: number
    /** The first attempt's id, on a retry; null on attempt 1. Always set by `listServiceJobs`. */
    retryOf?: string | null
}

/**
 * The service-caller poll view: an org's jobs newest-first, optionally filtered by status, WITHOUT
 * timelines (a poller wants current state, not the whole history — keep it light). Tenant-scoped by
 * RLS AND org-filtered, same two boundaries as listJobs. Default limit 50.
 */
export async function listServiceJobs(
    db: DbPort,
    tenantId: string,
    orgId: string,
    opts?: { status?: JobStatus; limit?: number },
): Promise<ServiceJobView[]> {
    const limit = opts?.limit ?? 50
    return db.withTenant(tenantId, async (trx) => {
        const rows = await trx
            .selectFrom('jobs')
            .select(['id', 'kind', 'status', 'payload', 'result_key', 'error', 'attempt', 'retry_of', 'created_at'])
            .where('org_id', '=', orgId)
            // A retry still waiting out its delay is no job a service caller may run yet: the tick starts it.
            .where('run_after', 'is', null)
            .$if(opts?.status !== undefined, (qb) => qb.where('status', '=', opts!.status!))
            .orderBy('created_at', 'desc')
            .limit(limit)
            .execute()
        return rows.map((r) => ({
            id: r.id,
            kind: r.kind,
            status: r.status as JobStatus,
            payload: r.payload,
            createdAt: toIso(r.created_at),
            resultKey: r.result_key,
            error: r.error,
            attempt: r.attempt,
            retryOf: r.retry_of,
        }))
    })
}

/**
 * Resolves a job id to its status ONLY when it belongs to `orgId` within `tenantId` — returns null
 * both when the job is absent and when it belongs to another org (a foreign org's job must be
 * indistinguishable from a missing one, so a caller can't probe other teams' job ids).
 */
export async function jobForOrg(
    db: DbPort,
    tenantId: string,
    orgId: string,
    jobId: string,
): Promise<{ id: string; status: JobStatus } | null> {
    return db.withTenant(tenantId, async (trx) => {
        const row = await trx
            .selectFrom('jobs')
            .select(['id', 'status'])
            .where('id', '=', jobId)
            .where('org_id', '=', orgId)
            .executeTakeFirst()
        return row ? { id: row.id, status: row.status as JobStatus } : null
    })
}

/**
 * Idempotent inbound-webhook completion (the real CodeBuild build's final POST reports terminal
 * status here). NotFoundError when the job isn't in the tenant. If the job is already in the
 * requested terminal state → 'idempotent' (a webhook redelivery is expected, not an error). A job
 * still 'queued' walks through 'running' (message 'completion webhook') first so the timeline always
 * reads queued -> running -> terminal. Every write goes through recordJobStatus (the row-locked
 * choke point).
 *
 * The webhook payload names the tenant, but the ORG namespace a resultKey may live in is the job
 * row's to decide — a planted same-tenant foreign-org key dies here as 'invalid-result-key' (the
 * service status route enforces the same prefix from its caller identity).
 *
 * Two deliveries can race the same still-queued job: the loser's mid-walk InvalidTransitionError is
 * resolved by LOOKING AGAIN — idempotent when the world reached the requested state, one more walk
 * while it's still in flight — never by bouncing the vendor with the 409 the idempotent-redelivery
 * contract exists to avoid. A genuinely illegal hop (completed -> failed) still throws immediately
 * via the terminal pre-check. The retry bound is generous: after one lost race the job is at least
 * 'running', so the next walk is single-hop.
 */
export async function recordWebhookCompletion(
    db: DbPort,
    input: { tenantId: string; jobId: string; status: 'completed' | 'failed'; resultKey?: string; error?: string },
): Promise<'applied' | 'idempotent' | 'invalid-result-key'> {
    const extra = { resultKey: input.resultKey, error: input.error }
    for (let attempt = 0; ; attempt++) {
        const row = await db.withTenant(input.tenantId, (trx) =>
            trx.selectFrom('jobs').select(['status', 'org_id']).where('id', '=', input.jobId).executeTakeFirst(),
        )
        if (!row) throw new NotFoundError(`job not found in tenant: ${input.jobId}`)
        if (input.resultKey !== undefined && !input.resultKey.startsWith(exportKeyPrefix(input.tenantId, row.org_id))) {
            return 'invalid-result-key'
        }
        const current = row.status as JobStatus
        if (current === input.status) return 'idempotent'
        if (jobStatusMachine.isTerminal(current)) jobStatusMachine.assertTransition(current, input.status)
        try {
            if (current === 'queued') {
                await recordJobStatus(db, input.tenantId, input.jobId, 'running', { message: 'completion webhook' })
            }
            await recordJobStatus(db, input.tenantId, input.jobId, input.status, extra)
            return 'applied'
        } catch (error) {
            if (error instanceof InvalidTransitionError && attempt < 2) continue
            throw error
        }
    }
}

/**
 * Resolves a job's kind + owning org by id within a tenant (RLS-scoped) — the notification fan-out
 * needs both to decide whether a terminal job is user-facing and to address the org's admins.
 * Null when the job isn't in the tenant. A thin read, deliberately not folded into recordJobStatus so
 * the status choke point stays free of the notification/adapters layer (the webhook-enqueue precedent).
 * `attempt` is which attempt the row is, and `retried` whether a later attempt of the same work exists, which a failure
 * that armed a retry has (safeinsights/sssb#135): that failure is not the job's end.
 */
export async function jobKindAndOrg(
    db: DbPort,
    tenantId: string,
    jobId: string,
): Promise<{
    kind: string
    orgId: string | null
    requestedBy: string | null
    attempt: number
    retried: boolean
} | null> {
    return db.withTenant(tenantId, async (trx) => {
        const row = await trx
            .selectFrom('jobs')
            .select(['kind', 'org_id', 'requested_by', 'attempt', 'retry_of'])
            .where('id', '=', jobId)
            .executeTakeFirst()
        if (!row) return null
        const later = await trx
            .selectFrom('jobs')
            .select('id')
            .where('retry_of', '=', row.retry_of ?? jobId)
            .where('attempt', '>', row.attempt)
            .executeTakeFirst()
        return {
            kind: row.kind,
            orgId: row.org_id,
            requestedBy: row.requested_by,
            attempt: row.attempt,
            retried: later !== undefined,
        }
    })
}

/**
 * Loads timeline entries for the given job ids (chronological), grouped by job. Accepts either a
 * tenant-scoped transaction (product paths) or the raw handle (the simulated-mode cross-tenant world view).
 */
export async function loadTimelines(
    executor: Kysely<DB> | Transaction<DB>,
    jobIds: string[],
): Promise<Map<string, JobTimelineEntry[]>> {
    const changes = await executor
        .selectFrom('job_status_changes')
        .select(['job_id', 'status', 'message', 'at'])
        .where('job_id', 'in', jobIds)
        .orderBy('at', 'asc')
        .execute()
    const grouped = new Map<string, JobTimelineEntry[]>()
    for (const change of changes) {
        const list = grouped.get(change.job_id) ?? []
        list.push({ status: change.status as JobStatus, message: change.message, at: toIso(change.at) })
        grouped.set(change.job_id, list)
    }
    return grouped
}
