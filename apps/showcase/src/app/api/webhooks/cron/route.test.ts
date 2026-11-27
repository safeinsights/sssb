import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { makeTestTmpDir } from '@sssb/tools/testing/tmp-dir'
import { devWebhookSecret } from '@sssb/kit/adapters/fake/service-auth'
import { POST } from './route'

// The registry is the one thing the tick takes from @sssb/kit/adapters/index (a real import trips server-only in a
// test env): hand it the fake database and a jobs port that spawns nothing. Everything else is the real route,
// the real guard and the real tick.
const spawned = vi.hoisted(() => ({ calls: 0 }))
vi.mock('@sssb/kit/adapters/index', async () => {
    const { fakeDb } = await import('@sssb/kit/adapters/fake/db')
    return {
        db: fakeDb,
        jobs: {
            async start() {
                spawned.calls += 1
            },
        },
        isSimulated: true,
    }
})

const tmp = makeTestTmpDir('app-cron-route-')
beforeAll(() => {
    process.env.APP_DATA_DIR = tmp
})
afterAll(() => {
    delete process.env.APP_DATA_DIR
})

function tick(authorization?: string): Promise<Response> {
    const headers: Record<string, string> = {}
    if (authorization !== undefined) headers.authorization = authorization
    // The showcase's guard (which also maps port errors) takes Next's route context as a second argument.
    return POST(new Request('http://localhost/api/webhooks/cron', { method: 'POST', headers }), {
        params: Promise.resolve({}),
    })
}

describe('POST /api/webhooks/cron', () => {
    test('is never open: no secret, a wrong secret and a malformed header are all an opaque 401', async () => {
        const wrong = `Bearer ${'f'.repeat(devWebhookSecret().length)}`
        for (const authorization of [undefined, wrong, `Basic ${devWebhookSecret()}`]) {
            const response = await tick(authorization)
            expect(response.status, String(authorization)).toBe(401)
            expect(await response.json()).toEqual({ error: 'unauthorized' })
        }
        expect(spawned.calls).toBe(0)
    })

    test("with the shared secret it runs SSSB's tick and says what it did", async () => {
        const response = await tick(`Bearer ${devWebhookSecret()}`)

        expect(response.status).toBe(200)
        const body = (await response.json()) as { stoppedBy: unknown; deliveries: { stoppedBy: unknown } }
        expect(body).toEqual({
            ok: true,
            spawned: expect.any(Number),
            failed: 0,
            deferred: expect.any(Number),
            stoppedBy: body.stoppedBy,
            deliveries: {
                delivered: expect.any(Number),
                failed: expect.any(Number),
                dead: expect.any(Number),
                deferred: expect.any(Number),
                stoppedBy: body.deliveries.stoppedBy,
            },
        })
        // A tick is bounded: what stopped each drain, if anything (a slow first database start can spend a window).
        expect([null, 'items', 'time']).toContain(body.stoppedBy)
        expect([null, 'items', 'time']).toContain(body.deliveries.stoppedBy)
    })
})
