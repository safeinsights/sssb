import { computeNextRunAt, parseScheduleSpec, type ScheduleSpec } from '../core/schedules'
import type { DbPort } from '../ports/db'
import type { JobsPort } from '../ports/jobs'
import { backoffDelayMs } from '../core/webhook-events'
import { recordAuditEvent } from './audit'
import {
    beforeDeadline,
    type DrainBudget,
    type DrainLeft,
    drainFairly,
    listingLimit,
    resolveDrainBudget,
} from './drain-budget'
import { family } from './family'
import { toIso } from './jobs'

/** Opaque actor id for the system-initiated scheduler in the audit trail (no user drives a tick). */
const SCHEDULER_ACTOR = 'system:scheduler'

/**
 * Safety bound on the coalesce loop (see computeNextRunAt's drift note). A pathological combination —
 * a 1-minute interval and a world-clock jump of years — is capped here; beyond it we anchor the next
 * run to `now` (losing phase, the acceptable degenerate case) rather than spin.
 */
const MAX_COALESCE = 100_000

/**
 * THE scheduled-work drain. Finds every enabled schedule whose next_run_at is due at `now`,
 * and for each: spawns a job through the EXISTING jobs machinery (the same jobs row + queued timeline
 * the export job uses), records an audit event, and advances next_run_at.
 *
 * `now` is supplied by the caller so the trigger source owns the clock: the real EventBridge tick
 * passes real time; the fake Simulator controls pass the simulated world-clock time (worldNow). A
 * tick belongs to no one tenant, so it enumerates tenants through the raw handle (the `tenants`
 * table carries no RLS — the packages/kit/src/db/tenant-lookup.ts precedent) and then reads each tenant's due
 * schedules INSIDE db.withTenant. That per-tenant shape is load-bearing, not style: `job_schedules`
 * is FORCE RLS, so a raw cross-tenant scan of it would return zero rows on a real Postgres role
 * (only pglite's superuser default made it appear to work), and the tick would silently never fire.
 * Scanning under withTenant needs no privileged role in any mode, and RLS contains every read and
 * write the same way.
 *
 * IDEMPOTENCY. The spawn and the next_run_at advance commit in ONE tenant-scoped transaction that
 * locks the schedule row FOR UPDATE (the recordJobStatus pattern). A second tick racing the same row
 * blocks on the lock, then sees next_run_at already advanced past `now` and skips — a tick that fires
 * twice can never double-spawn. Missed slots (a late tick, or a demo clock-jump across several
 * periods) coalesce: the row advances to the first slot after `now` and fires ONCE, never one job per
 * skipped period. jobs.start() runs only AFTER that transaction commits, exactly as submitJob does, so
 * a handler never observes a job — or a schedule state — that isn't durable yet.
 *
 * FAULT ISOLATION. One bad row must not stall every other schedule: each schedule drains inside its
 * own try/catch, counted in `failed`. What a failure leaves depends on where it happens. A failure
 * INSIDE the transaction (a malformed spec that parseScheduleSpec rejects, a failed insert) rolls it
 * back, so next_run_at never advanced; `recordSpawnFailure` then turns off a schedule whose spec does not parse and
 * backs off any other, so it is tried again later, ever less often (safeinsights/sssb#215). A failure AFTER it
 * commits (the audit insert, or jobs.start()) is NOT retried: the job row is already `queued` and the
 * schedule has already moved on to its next slot, so that period's run is not started by this code.
 * Retrying would make the spawn at-least-once for handlers written to run at most once. The job left
 * `queued` is the runner's to deal with: the in-process runner's sweep fails a job left queued too
 * long, and the CodeBuild runner's sweep one whose build never started; under any other runner it stays queued.
 *
 * BOUND. With a budget, one call spawns at most `budget.maxItems` schedules and starts none after `budget.deadline`,
 * taking one due schedule from each tenant in turn, the tenants and each tenant's listed schedules in a fresh random
 * order (./drain-budget.ts); `runScheduledTick` always passes one. Without a budget it drains every due schedule,
 * each tenant's oldest first. The result says how many due schedules it left for a later tick and why.
 */
export async function runDueSchedules(
    db: DbPort,
    jobs: JobsPort,
    now: Date,
    budget?: DrainBudget,
): Promise<{ spawned: number; failed: number } & DrainLeft> {
    const limit = resolveDrainBudget(budget)
    let spawned = 0
    let failed = 0
    // BOUNDED AND FAIR (./drain-budget.ts, safeinsights/sssb#97): at most `limit.maxItems` spawns, none started after
    // its deadline, one tenant's schedule at a time in turn. A due schedule left over is untouched, so the next tick
    // lists it again.
    if (!beforeDeadline(limit)) return { spawned, failed, deferred: 0, stoppedBy: 'time' }
    await db.ready()
    const tenants = await db.getDb().selectFrom('tenants').select('id').execute()
    const perTenant = listingLimit(limit)
    const left = await drainFairly(
        tenants,
        limit,
        (tenantId) =>
            db.withTenant(tenantId, (trx) =>
                trx
                    .selectFrom('job_schedules')
                    .select('id')
                    .where('enabled', '=', true)
                    .where('next_run_at', '<=', now)
                    .orderBy('next_run_at', 'asc')
                    .orderBy('id', 'asc')
                    .$if(perTenant !== null, (qb) => qb.limit(perTenant ?? 0))
                    .execute(),
            ),
        (row) => row.id,
        async (row, tenantId) => {
            try {
                spawned += await drainOne(db, jobs, now, { id: row.id, tenant_id: tenantId })
            } catch {
                failed += 1
            }
        },
    )
    return { spawned, failed, ...left }
}

/** Drains one due schedule (the locked spawn+advance transaction, then audit + start). Returns the
 *  number of jobs spawned (0 when the under-lock re-check skips the row). */
async function drainOne(
    db: DbPort,
    jobs: JobsPort,
    now: Date,
    schedule: { id: string; tenant_id: string },
): Promise<number> {
    const result = await spawnInTransaction(db, now, schedule).catch(async (error: unknown) => {
        // The spawn transaction rolled back, so the schedule is still due: back it off, or turn it off (#215).
        await recordSpawnFailure(db, now, schedule, error)
        throw error
    })
    if (!result) return 0

    // Deliberately non-atomic with the spawn (the house audit pattern — its own transaction after
    // commit): a system-initiated firing, attributed to the scheduler actor.
    await recordAuditEvent(db, {
        tenantId: schedule.tenant_id,
        orgId: result.orgId,
        actorUserId: SCHEDULER_ACTOR,
        action: 'schedule.fired',
        subjectType: 'JobSchedule',
        subjectId: schedule.id,
    })
    await jobs.start({
        id: result.jobId,
        kind: result.kind,
        tenantId: schedule.tenant_id,
        orgId: result.orgId,
        payload: { scheduleId: schedule.id },
    })
    return 1
}

/** The locked spawn+advance transaction; null when the under-lock re-check finds nothing to do. */
async function spawnInTransaction(
    db: DbPort,
    now: Date,
    schedule: { id: string; tenant_id: string },
): Promise<{ jobId: string; kind: string; orgId: string } | null> {
    return db.withTenant(schedule.tenant_id, async (trx) => {
        const locked = await trx
            .selectFrom('job_schedules')
            .select(['enabled', 'spec', 'kind', 'org_id', 'next_run_at'])
            .where('id', '=', schedule.id)
            .$call(family.lockRow)
            .executeTakeFirst()
        // Re-check under the lock: enabled may have flipped, or a concurrent tick may have already
        // advanced next_run_at past `now` — either way this tick does nothing for the row.
        if (!locked || !locked.enabled || new Date(locked.next_run_at) > now) return null
        const spec = parseScheduleSpec(locked.spec)

        const job = await trx
            .insertInto('jobs')
            .values({
                tenant_id: schedule.tenant_id,
                org_id: locked.org_id,
                kind: locked.kind,
                payload: { scheduleId: schedule.id },
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        await trx
            .insertInto('job_status_changes')
            .values({ tenant_id: schedule.tenant_id, job_id: job.id, status: 'queued', message: 'scheduled' })
            .execute()

        // Advance from the schedule's OWN scheduled time (anti-drift), coalescing past `now`.
        let next = computeNextRunAt(spec, new Date(locked.next_run_at))
        for (let i = 0; next.getTime() <= now.getTime() && i < MAX_COALESCE; i++) {
            next = computeNextRunAt(spec, next)
        }
        if (next.getTime() <= now.getTime()) next = computeNextRunAt(spec, now)
        await trx
            .updateTable('job_schedules')
            .set({ next_run_at: next, failure_count: 0, last_error: null })
            .where('id', '=', schedule.id)
            .execute()

        return { jobId: job.id, kind: locked.kind, orgId: locked.org_id }
    })
}

/** How many characters (code points) of a failure's message a schedule keeps in `last_error`. */
const LAST_ERROR_MAX = 500

/** The first `max` code points of `text`: never half a surrogate pair. */
function clip(text: string, max: number): string {
    return Array.from(text).slice(0, max).join('')
}

/**
 * A schedule's spawn failed INSIDE its transaction, which rolled back, so the schedule is still due (safeinsights/sssb
 * #215). Left so, it would fail again on every tick and take one of its tenant's turns each time. In a transaction of
 * its own, under the row lock, this counts the failure and keeps its message (`failure_count`, `last_error`), then:
 *
 * - a spec that does not parse can never spawn, so the schedule is DISABLED and an audit event (`schedule.disabled`,
 *   saying so) records it; the
 *   error is the schedule's `last_error`. Someone must fix the spec and enable it again.
 * - any other failure may pass (an insert the database refused for a moment), so the schedule BACKS OFF: its
 *   `next_run_at` moves to `now` plus the webhook deliveries' backoff for that many failures in a row (one minute, then
 *   five, thirty, two hours, six hours, and six hours on). A schedule that fails every time is therefore due ever less
 *   often, and never holds its tenant's oldest due slot for long.
 *
 * The next spawn that commits resets both columns. A schedule another tick fired, advanced or turned off meanwhile is
 * left alone. A failure here is logged, never thrown: the spawn's own error is what the drain counts.
 */
async function recordSpawnFailure(
    db: DbPort,
    now: Date,
    schedule: { id: string; tenant_id: string },
    error: unknown,
): Promise<void> {
    const message = clip(error instanceof Error ? error.message : String(error), LAST_ERROR_MAX)
    try {
        const disabled = await db.withTenant(schedule.tenant_id, async (trx) => {
            const row = await trx
                .selectFrom('job_schedules')
                .select(['enabled', 'spec', 'org_id', 'next_run_at', 'failure_count'])
                .where('id', '=', schedule.id)
                .$call(family.lockRow)
                .executeTakeFirst()
            if (!row || !row.enabled || new Date(row.next_run_at) > now) return null
            const failures = row.failure_count + 1
            const unparseable = (() => {
                try {
                    parseScheduleSpec(row.spec)
                    return false
                } catch {
                    return true
                }
            })()
            await trx
                .updateTable('job_schedules')
                .set({
                    failure_count: failures,
                    last_error: message,
                    ...(unparseable
                        ? { enabled: false }
                        : { next_run_at: new Date(now.getTime() + backoffDelayMs(failures)) }),
                })
                .where('id', '=', schedule.id)
                .execute()
            return unparseable ? { orgId: row.org_id } : null
        })
        if (!disabled) return
        await recordAuditEvent(db, {
            tenantId: schedule.tenant_id,
            orgId: disabled.orgId,
            actorUserId: SCHEDULER_ACTOR,
            action: 'schedule.disabled',
            subjectType: 'JobSchedule',
            subjectId: schedule.id,
            // The reason alone: the error echoes the stored spec, whatever it holds, which the audit log may refuse (an
            // address, a token). The error itself is the schedule's `last_error`.
            detail: { reason: 'spec does not parse' },
        })
    } catch (failure) {
        console.warn(
            `SSSB scheduler: schedule ${schedule.id} failed to spawn, and recording that failed too: ${
                failure instanceof Error ? failure.message : String(failure)
            }`,
        )
    }
}

/** One schedule as the Simulator Jobs tab sees it, joined to tenant/org slugs (NOT a product view). */
export interface WorldSchedule {
    id: string
    kind: string
    /** Null when the stored spec does not parse: such a schedule is shown, turned off, with its `lastError` (#215). */
    spec: ScheduleSpec | null
    nextRunAt: string
    enabled: boolean
    /** Spawns in a row that failed inside the spawn transaction, and the latest one's message (#215). */
    failureCount: number
    lastError: string | null
    tenantSlug: string
    orgSlug: string
}

/**
 * Every schedule across ALL tenants, joined to tenant/org slugs, ordered by next fire — the Simulator
 * Jobs tab's schedule view. A raw cross-tenant read like the Jobs god-view (simulated-mode-only surface;
 * the route gates it), reaching past the tenant RLS scope on purpose.
 */
export async function listSchedulesForWorld(db: DbPort): Promise<WorldSchedule[]> {
    await db.ready()
    const rows = await db
        .getDb()
        .selectFrom('job_schedules')
        .innerJoin('tenants', 'tenants.id', 'job_schedules.tenant_id')
        .innerJoin('organizations', 'organizations.id', 'job_schedules.org_id')
        .select([
            'job_schedules.id as id',
            'job_schedules.kind as kind',
            'job_schedules.spec as spec',
            'job_schedules.next_run_at as next_run_at',
            'job_schedules.enabled as enabled',
            'job_schedules.failure_count as failure_count',
            'job_schedules.last_error as last_error',
            'tenants.slug as tenant_slug',
            'organizations.slug as org_slug',
        ])
        .orderBy('job_schedules.next_run_at', 'asc')
        .execute()
    return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        spec: specOrNull(r.spec),
        nextRunAt: toIso(r.next_run_at),
        enabled: r.enabled,
        failureCount: r.failure_count,
        lastError: r.last_error,
        tenantSlug: r.tenant_slug,
        orgSlug: r.org_slug,
    }))
}

/** The spec if it parses, else null: one bad row must not take the whole world view down with it. */
function specOrNull(value: unknown): ScheduleSpec | null {
    try {
        return parseScheduleSpec(value)
    } catch {
        return null
    }
}
