import { afterEach, describe, expect, test, vi } from 'vitest'
import { dispatchWebhook } from './webhook-dispatch'

// The real path only: the dispatcher's one import from the registry is the run mode.
vi.mock('../adapters/index', () => ({ isSimulated: false }))

afterEach(() => {
    vi.unstubAllGlobals()
})

const INPUT = {
    deliveryId: 'delivery-one',
    endpointId: 'endpoint-one',
    url: 'https://hooks.example.test/in',
    headers: {},
    body: '{}',
}

function responseWithBody(status: number): { response: Response; cancelled: () => boolean } {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            controller.enqueue(new TextEncoder().encode('a body nobody reads'))
        },
        cancel() {
            cancelled = true
        },
    })
    return { response: new Response(body, { status }), cancelled: () => cancelled }
}

describe('dispatchWebhook (real mode)', () => {
    test.each([200, 500])(
        'cancels the unread response body (status %i) so the connection is released',
        async (status) => {
            const { response, cancelled } = responseWithBody(status)
            vi.stubGlobal(
                'fetch',
                vi.fn(async () => response),
            )
            const result = await dispatchWebhook(INPUT)
            expect(result.status).toBe(status)
            expect(result.delivered).toBe(status === 200)
            expect(cancelled()).toBe(true)
        },
    )

    test('a network failure is a failed attempt, not a throw', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => Promise.reject(new Error('connection refused'))),
        )
        expect(await dispatchWebhook(INPUT)).toEqual({ delivered: false, error: 'connection refused' })
    })
})
