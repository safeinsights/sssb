import type { JobHandler } from '@sssb/kit/ports/jobs'

/**
 * The handler behind the fixture's retrying kind (`flaky-dockets`, whose `jobRetry` allows three attempts): it fails
 * while its attempt is at most the payload's `failTimes` (`{ failTimes: 1 }` fails once, then succeeds; `{ failTimes:
 * 3 }` fails every attempt), and records each run it sees, by attempt and first job id, in `flakyRuns`, so a test can
 * read which attempts ran and that every one carried the same `firstJobId`. Writes nothing else.
 */
export const flakyRuns: { jobId: string; attempt: number; firstJobId: string }[] = []

export const flakyDocketsHandler: JobHandler = async (payload, ctx) => {
    const attempt = ctx.attempt ?? 1
    flakyRuns.push({ jobId: ctx.jobId, attempt, firstJobId: ctx.firstJobId ?? ctx.jobId })
    const failTimes =
        typeof payload === 'object' &&
        payload !== null &&
        'failTimes' in payload &&
        typeof payload.failTimes === 'number'
            ? payload.failTimes
            : 0
    if (attempt <= failTimes) throw new Error(`fixture: attempt ${attempt} asked to fail`)
    return {}
}
