// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * The PostHog adapter with the SDK replaced: `capture` waits for the event to be sent (a Lambda is frozen once its
 * response goes, so an event left queued may never leave), and a PostHog that fails or never answers costs at most
 * CAPTURE_TIMEOUT_MS and never an error; a flag read is held to FLAG_TIMEOUT_MS (safeinsights/sssb#104), and answers the
 * default when it fails or outruns it. Never run against a real project (cutover row `analytics`).
 */
const captureImmediate = vi.fn<(props: unknown) => Promise<void>>()
const capture = vi.fn()
const isFeatureEnabled = vi.fn<(flag: string, distinctId: string) => Promise<boolean | undefined>>()
const clientOptions = vi.hoisted(() => ({ last: undefined as Record<string, unknown> | undefined }))
vi.mock('posthog-node', () => ({
    PostHog: class {
        constructor(_apiKey: string, options: Record<string, unknown>) {
            clientOptions.last = options
        }
        captureImmediate = captureImmediate
        capture = capture
        isFeatureEnabled = isFeatureEnabled
    },
}))

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
    captureImmediate.mockReset()
    capture.mockReset()
    isFeatureEnabled.mockReset()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
    warn.mockRestore()
    vi.useRealTimers()
})

async function adapter() {
    const { createRealAnalytics, CAPTURE_TIMEOUT_MS } = await import('./analytics')
    return { analytics: createRealAnalytics('key', 'https://posthog.example'), CAPTURE_TIMEOUT_MS }
}

describe('real analytics', () => {
    test('capture resolves only once the event has been sent', async () => {
        const { analytics } = await adapter()
        let send!: () => void
        captureImmediate.mockImplementation(() => new Promise<void>((resolve) => (send = resolve)))
        let done = false
        const captured = analytics.capture('org_invite_sent', { role: 'member' }, 'u1').then(() => (done = true))
        await Promise.resolve()
        await Promise.resolve()
        expect(captureImmediate).toHaveBeenCalledWith({
            distinctId: 'u1',
            event: 'org_invite_sent',
            properties: { role: 'member' },
        })
        expect(capture, 'never the queued capture, which a frozen Lambda may never flush').not.toHaveBeenCalled()
        expect(done).toBe(false)
        send()
        await captured
        expect(done).toBe(true)
        expect(warn).not.toHaveBeenCalled()
    })

    test('a PostHog that never answers holds capture for CAPTURE_TIMEOUT_MS at most, then the event is dropped', async () => {
        vi.useFakeTimers()
        const { analytics, CAPTURE_TIMEOUT_MS } = await adapter()
        captureImmediate.mockImplementation(() => new Promise<void>(() => {}))
        let done = false
        const captured = analytics.capture('assistant_asked').then(() => (done = true))
        await vi.advanceTimersByTimeAsync(CAPTURE_TIMEOUT_MS - 1)
        expect(done).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        await captured
        expect(done).toBe(true)
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/dropped event assistant_asked: .*in time/))
    })

    test('a failed send is logged, never thrown', async () => {
        const { analytics } = await adapter()
        captureImmediate.mockRejectedValue(new Error('posthog is down'))
        await expect(analytics.capture('assistant_asked')).resolves.toBeUndefined()
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/dropped event assistant_asked: posthog is down/))
    })
})

describe('real analytics, reading a feature flag', () => {
    async function flagAdapter() {
        const { createRealAnalytics, FLAG_TIMEOUT_MS } = await import('./analytics')
        return { analytics: createRealAnalytics('key', 'https://posthog.example'), FLAG_TIMEOUT_MS }
    }

    test("tells the client the bound, with no retries: the client's own is three seconds and one retry", async () => {
        const { FLAG_TIMEOUT_MS } = await flagAdapter()
        expect(clientOptions.last).toMatchObject({
            featureFlagsRequestTimeoutMs: FLAG_TIMEOUT_MS,
            featureFlagsRequestMaxRetries: 0,
        })
        expect(FLAG_TIMEOUT_MS).toBeLessThan(2_000)
    })

    test.each([
        [true, false, true],
        [false, true, false],
    ])('answers the flag it read (%s, with the default %s)', async (read, fallback, expected) => {
        const { analytics } = await flagAdapter()
        isFeatureEnabled.mockResolvedValue(read)
        expect(await analytics.isFlagEnabled('beta', fallback)).toBe(expected)
        expect(isFeatureEnabled).toHaveBeenCalledWith('beta', 'server')
    })

    test('answers the default for a flag PostHog does not know', async () => {
        const { analytics } = await flagAdapter()
        isFeatureEnabled.mockResolvedValue(undefined)
        expect(await analytics.isFlagEnabled('beta', true)).toBe(true)
        expect(await analytics.isFlagEnabled('beta')).toBe(false)
    })

    test('answers the default when the read fails', async () => {
        const { analytics } = await flagAdapter()
        isFeatureEnabled.mockRejectedValue(new Error('posthog is down'))
        expect(await analytics.isFlagEnabled('beta', true)).toBe(true)
    })

    test('a read that never answers holds the page for FLAG_TIMEOUT_MS at most, then answers the default', async () => {
        vi.useFakeTimers()
        const { analytics, FLAG_TIMEOUT_MS } = await flagAdapter()
        isFeatureEnabled.mockImplementation(() => new Promise(() => {}))
        let answer: boolean | undefined
        const read = analytics.isFlagEnabled('beta', true).then((value) => (answer = value))
        await vi.advanceTimersByTimeAsync(FLAG_TIMEOUT_MS - 1)
        expect(answer).toBeUndefined()
        await vi.advanceTimersByTimeAsync(1)
        await read
        expect(answer).toBe(true)
        expect(vi.getTimerCount()).toBe(0)
    })

    test('a read that answers after the bound is ignored, and a late failure stays quiet', async () => {
        vi.useFakeTimers()
        const { analytics, FLAG_TIMEOUT_MS } = await flagAdapter()
        let fail!: (error: Error) => void
        isFeatureEnabled.mockImplementation(() => new Promise<boolean>((_, reject) => (fail = reject)))
        const read = analytics.isFlagEnabled('beta', false)
        await vi.advanceTimersByTimeAsync(FLAG_TIMEOUT_MS)
        expect(await read).toBe(false)
        fail(new Error('too late'))
        await vi.advanceTimersByTimeAsync(0)
    })

    test('a read inside the bound clears its timer', async () => {
        vi.useFakeTimers()
        const { analytics } = await flagAdapter()
        isFeatureEnabled.mockResolvedValue(true)
        expect(await analytics.isFlagEnabled('beta')).toBe(true)
        expect(vi.getTimerCount()).toBe(0)
    })
})
