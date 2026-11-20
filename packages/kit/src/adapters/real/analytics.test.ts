// @vitest-environment node
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * The PostHog adapter with the SDK replaced: `capture` waits for the event to be sent (a Lambda is frozen once its
 * response goes, so an event left queued may never leave), and a PostHog that fails or never answers costs at most
 * CAPTURE_TIMEOUT_MS and never an error. Never run against a real project (cutover row `analytics`).
 */
const captureImmediate = vi.fn<(props: unknown) => Promise<void>>()
const capture = vi.fn()
vi.mock('posthog-node', () => ({
    PostHog: class {
        captureImmediate = captureImmediate
        capture = capture
    },
}))

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
    captureImmediate.mockReset()
    capture.mockReset()
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
