import { loadAppMessages } from '@sssb/app-config/messages'
import { appJobKinds, jobRetry as seamJobRetry } from '@sssb/app-config/jobs'
import { NextIntlClientProvider } from 'next-intl'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { isJobRetry, jobRetryFor, MAX_JOB_ATTEMPTS, retryDelayMs, type JobRetry } from '../core/jobs'
import enFramework from '../i18n/messages/en.json'
import { mergeMessages } from '../i18n/messages'
import type { DemoWorldOptions } from './contracts'
import { DEMO_MAX_JOB_ATTEMPTS, demoJobRetryFor, demoRetryDelayMs, isDemoJobRetry } from './job-retry'
import { useDemoWorld } from './world'

/**
 * The static demo's twin of job retries (safeinsights/sssb#135; db/job-retries.test.ts pins the server's side): a kind
 * the composition root's `jobRetry` names is tried again after a failure, each attempt a row of its own that waits out
 * its delay on the world clock; Run pending does not step a waiting retry, advancing the clock past it does; a failure
 * that armed a retry notifies no one, and the last attempt notifies with `attempts` when it is not the first. The
 * twin's copy of the policy (./job-retry.ts) gives core/jobs' answers.
 */

type World = ReturnType<typeof useDemoWorld>

async function renderWorld(options: DemoWorldOptions): Promise<{ current: World }> {
    const messages = mergeMessages(enFramework, await loadAppMessages('en'))
    const result = {} as { current: World }
    function Probe() {
        result.current = useDemoWorld(options)
        return null
    }
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const root = createRoot(document.createElement('div'))
    await act(async () => {
        root.render(
            <NextIntlClientProvider locale="en" messages={messages}>
                <Probe />
            </NextIntlClientProvider>,
        )
    })
    unmounts.push(() => root.unmount())
    return result
}

const unmounts: Array<() => void> = []
afterEach(() => {
    for (const unmount of unmounts.splice(0)) act(unmount)
})

const RETRY: Record<string, JobRetry> = { 'flaky-dockets': { attempts: 3, delaysMs: [60_000, 600_000] } }

/** Ada, an admin of depot, signed in there with an endpoint for job webhooks. */
async function depotWorld(options: DemoWorldOptions) {
    const world = await renderWorld(options)
    act(() => world.current.signIn('fixture-lead'))
    act(() => world.current.setActiveOrgSlug('depot'))
    act(() =>
        world.current.createEndpoint({ url: 'https://depot.example.test/hook', eventKinds: ['job.status_changed'] }),
    )
    const rows = (kind: string) =>
        world.current.jobs.filter((job) => job.kind === kind).sort((a, b) => (a.attempt ?? 1) - (b.attempt ?? 1))
    /** The job notifications, one per (job, status) however many admins each reached. */
    const notified = () => [
        ...new Map(
            world.current.notifications
                .filter((n) => n.kind === 'job.completed')
                .map((n) => [JSON.stringify(n.payload), n.payload]),
        ).values(),
    ]
    const webhookStatuses = () =>
        world.current.deliveries
            .map((d) => (d.payload as { jobId: string; status: string }).status)
            .slice()
            .reverse()
    return { world, rows, notified, webhookStatuses }
}

describe('demo job retries', () => {
    it('runs a kind that retries once when its first attempt succeeds', async () => {
        const { world, rows, notified } = await depotWorld({ jobRetry: RETRY })
        act(() => world.current.startJob('flaky-dockets'))

        expect(rows('flaky-dockets')).toHaveLength(1)
        const [job] = rows('flaky-dockets')
        expect(job).toMatchObject({ status: 'completed', error: null })
        expect(notified()).toEqual([{ jobId: job!.id, jobKind: 'flaky-dockets', status: 'completed' }])
    })

    it('fails, waits out the delay (Run pending does not step it), then succeeds and notifies once', async () => {
        const { world, rows, notified, webhookStatuses } = await depotWorld({
            jobRetry: RETRY,
            jobOutcome: ({ attempt }) => (attempt === 1 ? { error: 'boom' } : undefined),
        })
        act(() => world.current.startJob('flaky-dockets'))

        const [first, second] = rows('flaky-dockets')
        expect(first).toMatchObject({ status: 'failed', error: 'boom' })
        expect(first!.timeline.at(-1)!.message).toMatch(/^retry armed: attempt 2 of 3 at \d{4}-/)
        expect(second).toMatchObject({ status: 'queued', attempt: 2, retryOf: first!.id })
        expect(second!.runAfterMs).toBe(Date.parse(world.current.clock.worldNowIso) + 60_000)
        expect(second!.timeline).toEqual([
            expect.objectContaining({ status: 'queued', message: 'attempt 2 of 3, after: boom' }),
        ])
        expect(notified()).toEqual([])
        expect(webhookStatuses()).toEqual(['failed'])

        act(() => world.current.runPendingJobs())
        expect(rows('flaky-dockets')[1]).toMatchObject({ status: 'queued' })

        act(() => world.current.clock.advance(59_999))
        expect(rows('flaky-dockets')[1]).toMatchObject({ status: 'queued' })

        act(() => world.current.clock.advance(1))
        expect(rows('flaky-dockets').map((job) => job.status)).toEqual(['failed', 'completed'])
        expect(rows('flaky-dockets')[1]!.runAfterMs).toBeNull()
        expect(notified()).toEqual([{ jobId: second!.id, jobKind: 'flaky-dockets', status: 'completed', attempts: 2 }])
        expect(webhookStatuses()).toEqual(['failed', 'completed'])
    })

    it('fails every attempt: three rows, one notification at the end with attempts 3', async () => {
        const { world, rows, notified } = await depotWorld({
            jobRetry: RETRY,
            jobOutcome: ({ attempt }) => ({ error: `boom ${attempt}` }),
        })
        act(() => world.current.startJob('flaky-dockets'))
        act(() => world.current.clock.advance(60_000))
        expect(notified()).toEqual([])
        // Attempt 2 failed and armed attempt 3, ten minutes out: run-due without moving the clock leaves it waiting.
        act(() => world.current.clock.runDue())
        expect(rows('flaky-dockets').map((job) => job.status)).toEqual(['failed', 'failed', 'queued'])
        act(() => world.current.clock.advance(600_000))

        const all = rows('flaky-dockets')
        expect(all.map((job) => [job.attempt ?? 1, job.status, job.error])).toEqual([
            [1, 'failed', 'boom 1'],
            [2, 'failed', 'boom 2'],
            [3, 'failed', 'boom 3'],
        ])
        expect(all[1]!.retryOf).toBe(all[0]!.id)
        expect(all[2]!.retryOf).toBe(all[0]!.id)
        expect(all[2]!.timeline[0]!.message).toBe('attempt 3 of 3, after: boom 2')
        expect(all[2]!.timeline.at(-1)).toMatchObject({ status: 'failed', message: null })
        expect(notified()).toEqual([{ jobId: all[2]!.id, jobKind: 'flaky-dockets', status: 'failed', attempts: 3 }])
    })

    it('starts a due retry from run-due, without moving the clock', async () => {
        const { world, rows } = await depotWorld({
            jobRetry: { 'flaky-dockets': { attempts: 2, delaysMs: [0] } },
            jobOutcome: ({ attempt }) => (attempt === 1 ? { error: 'boom' } : undefined),
        })
        act(() => world.current.startJob('flaky-dockets'))
        act(() => world.current.runPendingJobs())
        expect(rows('flaky-dockets')[1]).toMatchObject({ status: 'queued' })
        act(() => world.current.clock.runDue())
        expect(rows('flaky-dockets').map((job) => job.status)).toEqual(['failed', 'completed'])
    })

    it.each([
        ['export-dockets', 'always', true],
        ['sweep-dockets', 'failure', true],
        ['quiet-dockets', 'never', false],
    ])('a kind without jobRetry (%s, %s) fails once and notifies its failure: %s', async (kind, _mode, notifies) => {
        const { world, rows, notified } = await depotWorld({
            jobRetry: RETRY,
            jobNotify: { 'sweep-dockets': 'failure', 'quiet-dockets': 'never' },
            jobOutcome: () => ({ error: 'boom' }),
        })
        act(() => world.current.startJob(kind))
        act(() => world.current.clock.advance(24 * 60 * 60_000))

        expect(rows(kind)).toEqual([expect.objectContaining({ status: 'failed', error: 'boom' })])
        expect(rows(kind)[0]!.timeline.at(-1)).toMatchObject({ status: 'failed', message: null })
        expect(notified()).toEqual(notifies ? [{ jobId: rows(kind)[0]!.id, jobKind: kind, status: 'failed' }] : [])
    })

    it('Run pending honours jobOutcome for a held job', async () => {
        const { world, rows } = await depotWorld({ jobOutcome: () => ({ error: 'boom' }) })
        act(() => world.current.setFeatureFlag('jobs-held', true))
        act(() => world.current.startJob('export-dockets'))
        expect(rows('export-dockets')[0]).toMatchObject({ status: 'queued' })
        act(() => world.current.runPendingJobs())
        expect(rows('export-dockets')[0]).toMatchObject({ status: 'failed', error: 'boom' })
    })

    it('keeps a waiting retry out of the builder actor’s pool, as the server does', async () => {
        const { world, rows } = await depotWorld({
            jobRetry: RETRY,
            jobOutcome: ({ attempt }) => (attempt === 1 ? { error: 'boom' } : undefined),
        })
        act(() => world.current.startJob('flaky-dockets'))
        expect(rows('flaky-dockets')[1]).toMatchObject({ status: 'queued' })
        expect(await world.current.builderDriver([], () => {}).listBuilds()).toEqual([])
    })
})

describe("the twin's retry policy agrees with core/jobs'", () => {
    const entries: unknown[] = [
        { attempts: 1 },
        { attempts: 3 },
        { attempts: MAX_JOB_ATTEMPTS },
        { attempts: MAX_JOB_ATTEMPTS + 1 },
        { attempts: 0 },
        { attempts: -1 },
        { attempts: 2.5 },
        { attempts: '3' },
        { attempts: Number.NaN },
        { attempts: Number.POSITIVE_INFINITY },
        { attempts: 3, delaysMs: [] },
        { attempts: 3, delaysMs: [0, 10, 20] },
        { attempts: 3, delaysMs: [-1] },
        { attempts: 3, delaysMs: [Number.NaN] },
        { attempts: 3, delaysMs: [Number.POSITIVE_INFINITY] },
        { attempts: 3, delaysMs: ['10'] },
        { attempts: 3, delaysMs: '10' },
        { attempts: 3, delaysMs: null },
        { delaysMs: [10] },
        {},
        [],
        null,
        undefined,
        3,
        'attempts',
        () => ({ attempts: 3 }),
    ]

    it.each(entries.map((entry) => [entry]))('isJobRetry(%j)', (entry) => {
        expect(isDemoJobRetry(entry)).toBe(isJobRetry(entry))
    })

    it('has the same maximum', () => {
        expect(DEMO_MAX_JOB_ATTEMPTS).toBe(MAX_JOB_ATTEMPTS)
    })

    const policies: JobRetry[] = [
        { attempts: 5 },
        { attempts: 5, delaysMs: [] },
        { attempts: 5, delaysMs: [10] },
        { attempts: 5, delaysMs: [10, 20, 30] },
        { attempts: 10, delaysMs: [0, 0] },
    ]
    const failedAttempts = [-1, 0, 1, 2, 3, 4, 5, 9, 10, 12]
    it.each(policies.flatMap((policy) => failedAttempts.map((failed) => [policy, failed] as const)))(
        'retryDelayMs(%j, %i)',
        (policy, failed) => {
            expect(demoRetryDelayMs(policy, failed)).toBe(retryDelayMs(policy, failed))
        },
    )

    it("reads the seam's own jobRetry map as jobRetryFor does, kind by kind", () => {
        for (const kind of [...appJobKinds, 'digest-email', 'no-such-kind', 'constructor']) {
            expect(demoJobRetryFor(seamJobRetry, kind)).toEqual(jobRetryFor(kind))
        }
    })
})
