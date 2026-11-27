import * as jobsSeam from '@sssb/app-config/jobs'
import { appJobKinds, type AppJobKind } from '@sssb/app-config/jobs'
import { defineStateMachine } from './state-machine'
import { backoffDelayMs } from './webhook-events'

export const JOB_STATUSES = ['queued', 'running', 'completed', 'failed'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

/**
 * The job lifecycle. No queued -> completed shortcut on purpose: even an instant fake records the
 * full story (queued -> running -> completed), so the timeline reads identically whether the work
 * ran in-process (fake) or on CodeBuild (real). Both terminal states have no outgoing transitions.
 */
export const jobStatusMachine = defineStateMachine<JobStatus>({
    queued: ['running', 'failed'],
    running: ['completed', 'failed'],
    completed: [],
    failed: [],
})

// The FRAMEWORK's own job kinds. digest-email: the scheduled-work worked example — a
// scheduler (packages/kit/src/db/schedules.ts) spawns it through this same jobs machinery, and its handler composes
// an org digest and sends it via the email port. App kinds register through the seam
// (src/app-config/jobs.ts appJobKinds), composed below exactly like the migration registry — a
// new kind is how instances extend jobs (ADR-0012; "one worked example per class").
export const FRAMEWORK_JOB_KINDS = ['digest-email'] as const
type FrameworkJobKind = (typeof FRAMEWORK_JOB_KINDS)[number]

/** The full kind union: framework base + the app's registered kinds. */
export type JobKind = FrameworkJobKind | AppJobKind

export function isJobKind(value: string): value is JobKind {
    // Composed lazily (never a top-level spread) so the core↔seam value cycle stays safe: appJobKinds
    // is only read when isJobKind is CALLED (request time), never at module-init. See ADR-0012 risks.
    return (
        (FRAMEWORK_JOB_KINDS as readonly string[]).includes(value) || (appJobKinds as readonly string[]).includes(value)
    )
}

/**
 * When a job kind's terminal state notifies the team's admins: `always` (a completion and a failure, what every app
 * kind did before the setting existed, so the default), `failure` (only a failure) or `never`. An app says it per
 * kind in the seam's optional `jobNotify` export (`@sssb/app-config/jobs`); the framework's own kinds never notify.
 */
export const JOB_NOTIFY_MODES = ['always', 'failure', 'never'] as const
export type JobNotify = (typeof JOB_NOTIFY_MODES)[number]

export function isJobNotify(value: unknown): value is JobNotify {
    return (JOB_NOTIFY_MODES as readonly unknown[]).includes(value)
}

/** Whether a job that reached `status` is notified under `mode`. */
export function notifiesOn(mode: JobNotify, status: 'completed' | 'failed'): boolean {
    return mode === 'always' || (mode === 'failure' && status === 'failed')
}

/**
 * How a job kind is tried again after it fails (safeinsights/sssb#135): at most `attempts` runs in all (1 means no
 * retry), and before attempt n + 1 a wait of `delaysMs[n - 1]` milliseconds (the last delay repeats when the list is
 * shorter; with no list, the webhook deliveries' backoff). An app says it per kind in the seam's optional `jobRetry`
 * export (`@sssb/app-config/jobs`); a kind it leaves out runs once, as every kind did before, and the framework's own
 * kinds never retry. The next attempt is a NEW job row (`retry_of` names the first attempt), so `failed` stays terminal.
 *
 * The scheduled tick starts a due retry, so its period is the floor under every delay: a one-minute delay runs at the
 * next tick (every five minutes under @sssb/cdk's default). A retried handler runs again over whatever the failed
 * attempt left behind, so a kind that retries must be idempotent; its handler is told `ctx.attempt` and
 * `ctx.firstJobId`, a key stable across attempts.
 */
export interface JobRetry {
    attempts: number
    delaysMs?: readonly number[]
}

/** The most attempts a kind may ask for: a typo of 100 must not become a hundred runs of a failing job. */
export const MAX_JOB_ATTEMPTS = 10

/** The longest delay before a retry, thirty days: longer is a typo, and past JavaScript's date range would not arm. */
export const MAX_JOB_RETRY_DELAY_MS = 30 * 24 * 60 * 60 * 1000

/** A `jobRetry` entry SSSB will honour: a whole number of attempts from 1 to MAX_JOB_ATTEMPTS, delays from 0 to
 *  MAX_JOB_RETRY_DELAY_MS. */
export function isJobRetry(value: unknown): value is JobRetry {
    if (typeof value !== 'object' || value === null) return false
    const { attempts, delaysMs } = value as { attempts?: unknown; delaysMs?: unknown }
    if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 1 || attempts > MAX_JOB_ATTEMPTS) {
        return false
    }
    if (delaysMs === undefined) return true
    return (
        Array.isArray(delaysMs) &&
        delaysMs.every((d) => typeof d === 'number' && Number.isFinite(d) && d >= 0 && d <= MAX_JOB_RETRY_DELAY_MS)
    )
}

/** The wait before attempt `failedAttempt + 1` under `retry`: its own delays, else the webhook deliveries' backoff. */
export function retryDelayMs(retry: JobRetry, failedAttempt: number): number {
    const delays = retry.delaysMs
    if (!delays || delays.length === 0) return backoffDelayMs(failedAttempt)
    return delays[Math.min(Math.max(failedAttempt, 1), delays.length) - 1]!
}

/**
 * The retry setting of `kind`: the app's `jobRetry` entry (`@sssb/app-config/jobs`, optional as an export and as an
 * entry), read through the namespace as `jobNotify` is, so an app without the export still builds. A framework kind,
 * a kind the map leaves out, and an entry SSSB will not honour (`isJobRetry`) all run once.
 */
export function jobRetryFor(kind: string): JobRetry {
    if (!(appJobKinds as readonly string[]).includes(kind)) return { attempts: 1 }
    const setting = (jobsSeam as Record<string, unknown>)['jobRetry'] as Record<string, unknown> | undefined
    const entry = setting?.[kind]
    return isJobRetry(entry) ? entry : { attempts: 1 }
}

export function isJobStatus(value: string): value is JobStatus {
    return (JOB_STATUSES as readonly string[]).includes(value)
}

/**
 * The storage namespace a job's export artifacts must live in. Encodes BOTH tenant AND org because
 * storage isolation is purely by key convention: the service/webhook boundaries prefix-lock a
 * caller-supplied resultKey to this, so a planted key can never point a signed download at another
 * org's (or tenant's) artifact. Jobs with no active team use a reserved literal segment — org ids
 * are uuids, so 'no-org' cannot collide with a real org's namespace.
 */
export function exportKeyPrefix(tenantId: string, orgId: string | null): string {
    return `exports/${tenantId}/${orgId ?? 'no-org'}/`
}
