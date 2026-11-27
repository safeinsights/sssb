import type { JobRetry } from '../core/jobs'
import { backoffDelayMs } from '../core/webhook-events'

/**
 * The static demo's copy of core/jobs' retry policy (safeinsights/sssb#135): `isJobRetry`, `retryDelayMs` and
 * `MAX_JOB_ATTEMPTS`, re-implemented because core/jobs imports the seam's jobs module, and through it every server
 * handler, which the `file://` bundle cannot carry (the same reason ./world.ts does not value-import `notifiesOn`).
 * `job-retry.test.ts` holds the two copies to the same answers.
 */

/** core/jobs' MAX_JOB_ATTEMPTS. */
export const DEMO_MAX_JOB_ATTEMPTS = 10

/** core/jobs' isJobRetry: a whole number of attempts from 1 to the maximum, delays finite and ≥ 0. */
export function isDemoJobRetry(value: unknown): value is JobRetry {
    if (typeof value !== 'object' || value === null) return false
    const { attempts, delaysMs } = value as { attempts?: unknown; delaysMs?: unknown }
    if (
        typeof attempts !== 'number' ||
        !Number.isInteger(attempts) ||
        attempts < 1 ||
        attempts > DEMO_MAX_JOB_ATTEMPTS
    ) {
        return false
    }
    if (delaysMs === undefined) return true
    return Array.isArray(delaysMs) && delaysMs.every((d) => typeof d === 'number' && Number.isFinite(d) && d >= 0)
}

/** core/jobs' retryDelayMs: the wait before attempt `failedAttempt + 1`, the kind's own delays else the webhook backoff. */
export function demoRetryDelayMs(retry: JobRetry, failedAttempt: number): number {
    const delays = retry.delaysMs
    if (!delays || delays.length === 0) return backoffDelayMs(failedAttempt)
    return delays[Math.min(Math.max(failedAttempt, 1), delays.length) - 1]!
}

/** core/jobs' jobRetryFor over the map the composition root passed: a kind it leaves out, or an entry refused, runs once. */
export function demoJobRetryFor(setting: Readonly<Record<string, unknown>>, kind: string): JobRetry {
    const entry = Object.hasOwn(setting, kind) ? setting[kind] : undefined
    return isDemoJobRetry(entry) ? entry : { attempts: 1 }
}
