import { beforeEach, describe, expect, test, vi } from 'vitest'

// Drive the simulated-mode branch with a controllable analytics.capture (hoisted so the vi.mock factory
// can close over it). next/server.after is stubbed only so the import resolves — simulated mode never
// calls it (it runs the work inline for determinism), which is itself part of what we assert.
const { capture, mode } = vi.hoisted(() => ({ capture: vi.fn(async () => {}), mode: { simulated: true } }))
vi.mock('../adapters/index', () => ({
    get isSimulated() {
        return mode.simulated
    },
    analytics: { capture },
}))
const { after } = vi.hoisted(() => ({ after: vi.fn() }))
vi.mock('next/server', () => ({ after }))

import { deferAfterResponse } from './defer'

beforeEach(() => {
    capture.mockClear()
    after.mockClear()
    mode.simulated = true
})

describe('deferAfterResponse (simulated mode)', () => {
    test('runs the work INLINE, and captures a deferred_work marker BEFORE it (Simulator visibility)', async () => {
        // How many captures had fired by the time the work ran? Exactly one — the deferred_work marker,
        // proving order (marker first) AND that the work ran inline, not via a post-response after().
        let capturesWhenWorkRan = -1
        await deferAfterResponse('invite-email', async () => {
            capturesWhenWorkRan = capture.mock.calls.length
        })

        expect(capturesWhenWorkRan).toBe(1)
        expect(capture).toHaveBeenNthCalledWith(1, 'deferred_work', { label: 'invite-email' })
        expect(after).not.toHaveBeenCalled()
    })

    test('captures deferred_work_failed and does NOT throw when the work rejects', async () => {
        await expect(
            deferAfterResponse('invite-email', async () => {
                throw new Error('smtp down')
            }),
        ).resolves.toBeUndefined()

        expect(capture).toHaveBeenCalledWith('deferred_work', { label: 'invite-email' })
        expect(capture).toHaveBeenCalledWith('deferred_work_failed', { label: 'invite-email', message: 'smtp down' })
    })
})

describe('deferAfterResponse (real mode)', () => {
    test('runs the work after the response, and logs a failure as well as capturing it', async () => {
        mode.simulated = false
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        try {
            await deferAfterResponse('invite-email', async () => {
                throw new Error('the email port is absent')
            })
            expect(after).toHaveBeenCalledTimes(1)
            const scheduled = after.mock.calls[0]?.[0] as () => Promise<void>
            await scheduled()
            expect(warn).toHaveBeenCalledWith('SSSB deferred work "invite-email" failed: the email port is absent')
            expect(capture).toHaveBeenCalledWith('deferred_work_failed', {
                label: 'invite-email',
                message: 'the email port is absent',
            })
        } finally {
            warn.mockRestore()
        }
    })
})
