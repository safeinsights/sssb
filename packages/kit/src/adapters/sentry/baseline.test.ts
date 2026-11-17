import { beforeEach, describe, expect, it, vi } from 'vitest'

const init = vi.fn()
vi.mock('@sentry/nextjs', () => ({ init, captureRouterTransitionStart: vi.fn() }))

const { initServerSentry } = await import('./init')
const { initClientSentry } = await import('./client')

// Written out here rather than imported from ./baseline: the pin is this literal, so editing the module
// cannot move it. It is what v10 collected with `sendDefaultPii` unset (ADR-0010, addendum 2026-11-17).
const denied = ['forwarded', '-ip', 'remote-', 'via', '-user']
const V10_DATA_COLLECTION = {
    userInfo: false,
    cookies: false,
    httpHeaders: { request: { deny: denied }, response: { deny: denied } },
    httpBodies: [],
    urlQueryParams: { deny: denied },
    genAI: { inputs: false, outputs: false },
    mcp: { inputs: false, outputs: false },
    databaseQueryData: false,
    queues: false,
    graphQL: { document: false, variables: false },
}

describe.each([
    ['server/edge', initServerSentry],
    ['browser', initClientSentry],
])('the %s Sentry init keeps the v10 data-collection baseline', (_runtime, initSentry) => {
    beforeEach(() => init.mockClear())

    it('sets every dataCollection category explicitly, to exactly the v10 baseline', () => {
        initSentry()
        expect(init).toHaveBeenCalledTimes(1)
        // toStrictEqual: a removed key, a widened value, or a new category (which v11 would default to "collect")
        // each fail here. Widening is a privacy decision; change this literal and ADR-0010 together.
        expect(init.mock.calls[0]![0].dataCollection).toStrictEqual(V10_DATA_COLLECTION)
    })

    it('keeps the v10 attachStacktrace default and the scrubber', () => {
        initSentry()
        const options = init.mock.calls[0]![0]
        expect(options.attachStacktrace).toBe(false)
        expect(options.beforeSend).toBeTypeOf('function')
        // The removed v10 switch must not creep back in: 11.x ignores it, so it would only mislead a reader.
        expect(options).not.toHaveProperty('sendDefaultPii')
    })
})
