import { jobRetry } from '@sssb/app-config/jobs'
import { describe, expect, test, vi } from 'vitest'
import { InvalidTransitionError } from './state-machine'
import {
    FRAMEWORK_JOB_KINDS,
    isJobKind,
    isJobRetry,
    JOB_STATUSES,
    jobRetryFor,
    jobStatusMachine,
    MAX_JOB_ATTEMPTS,
    MAX_JOB_RETRY_DELAY_MS,
    retryDelayMs,
} from './jobs'
import { backoffDelayMs } from './webhook-events'

describe('job status machine', () => {
    test('covers exactly the declared statuses', () => {
        expect([...jobStatusMachine.states].sort()).toEqual([...JOB_STATUSES].sort())
    })

    test('queued may start running or fail, but never jump straight to completed', () => {
        expect(jobStatusMachine.canTransition('queued', 'running')).toBe(true)
        expect(jobStatusMachine.canTransition('queued', 'failed')).toBe(true)
        expect(jobStatusMachine.canTransition('queued', 'completed')).toBe(false)
        expect(() => jobStatusMachine.assertTransition('queued', 'completed')).toThrow(InvalidTransitionError)
    })

    test('running may complete or fail', () => {
        expect(jobStatusMachine.canTransition('running', 'completed')).toBe(true)
        expect(jobStatusMachine.canTransition('running', 'failed')).toBe(true)
        expect(jobStatusMachine.canTransition('running', 'queued')).toBe(false)
    })

    test('completed and failed are terminal', () => {
        expect(jobStatusMachine.isTerminal('completed')).toBe(true)
        expect(jobStatusMachine.isTerminal('failed')).toBe(true)
        expect(jobStatusMachine.isTerminal('queued')).toBe(false)
        expect(jobStatusMachine.isTerminal('running')).toBe(false)
    })
})

describe('isJobKind', () => {
    // The app-registered kinds are asserted in src/app-config/jobs.test.ts — this proves the framework
    // side + the composed rejection of unknowns.
    test('narrows the framework kinds and rejects unknowns', () => {
        for (const kind of FRAMEWORK_JOB_KINDS) expect(isJobKind(kind)).toBe(true)
        expect(isJobKind('digest-email')).toBe(true)
        expect(isJobKind('delete-everything')).toBe(false)
        expect(isJobKind('')).toBe(false)
    })
})

describe('job retries (safeinsights/sssb#135)', () => {
    test('a setting SSSB honours: whole attempts from 1 to the cap, delays finite and not negative', () => {
        expect(isJobRetry({ attempts: 1 })).toBe(true)
        expect(isJobRetry({ attempts: MAX_JOB_ATTEMPTS, delaysMs: [0, 60_000, MAX_JOB_RETRY_DELAY_MS] })).toBe(true)
        for (const bad of [
            null,
            3,
            {},
            { attempts: 0 },
            { attempts: 2.5 },
            { attempts: MAX_JOB_ATTEMPTS + 1 },
            { attempts: 2, delaysMs: 60_000 },
            { attempts: 2, delaysMs: [-1] },
            { attempts: 2, delaysMs: [Number.POSITIVE_INFINITY] },
            { attempts: 2, delaysMs: [MAX_JOB_RETRY_DELAY_MS + 1] },
            { attempts: 2, delaysMs: [1e16] },
            { attempts: 2, delaysMs: ['60s'] },
        ]) {
            expect(isJobRetry(bad), JSON.stringify(bad)).toBe(false)
        }
    })

    test("the delay before each attempt: the kind's own list, its last entry repeating, else the deliveries' backoff", () => {
        const retry = { attempts: 5, delaysMs: [1_000, 5_000] }
        expect([1, 2, 3, 4].map((failed) => retryDelayMs(retry, failed))).toEqual([1_000, 5_000, 5_000, 5_000])
        expect(retryDelayMs({ attempts: 3 }, 1)).toBe(backoffDelayMs(1))
        expect(retryDelayMs({ attempts: 3, delaysMs: [] }, 2)).toBe(backoffDelayMs(2))
    })

    test('the fixture seam sets what these tests and db/job-retries.test.ts assume: one kind that retries', () => {
        expect(jobRetry).toEqual({ 'flaky-dockets': { attempts: 3, delaysMs: [60_000, 600_000] } })
    })

    test("reads the fixture seam's entry, and runs once a kind it leaves out and every framework kind", () => {
        expect(jobRetryFor('flaky-dockets')).toEqual({ attempts: 3, delaysMs: [60_000, 600_000] })
        expect(jobRetryFor('export-dockets')).toEqual({ attempts: 1 })
        expect(jobRetryFor('digest-email')).toEqual({ attempts: 1 })
        expect(jobRetryFor('no-such-kind')).toEqual({ attempts: 1 })
    })

    test.each([
        ['has no jobRetry export', undefined],
        ['holds an entry SSSB will not honour', { 'flaky-dockets': { attempts: 100 } }],
    ])('a seam that %s runs the kind once', async (_name, jobRetry) => {
        vi.resetModules()
        vi.doMock('@sssb/app-config/jobs', async (importOriginal) => ({
            ...(await importOriginal<Record<string, unknown>>()),
            jobRetry,
        }))
        try {
            const { jobRetryFor: fresh } = await import('./jobs')
            expect(fresh('flaky-dockets')).toEqual({ attempts: 1 })
        } finally {
            vi.doUnmock('@sssb/app-config/jobs')
            vi.resetModules()
        }
    })
})
