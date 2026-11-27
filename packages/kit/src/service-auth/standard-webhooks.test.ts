import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { makeTestTmpDir } from '../testing/tmp-dir'
import { devWebhookSecret } from '../adapters/fake/service-auth'
import { AuthRequiredError } from '../ports/errors'
import {
    __resetStandardWebhookReplayGuard,
    signStandardWebhook,
    verifyStandardWebhook,
    verifyStandardWebhookSignature,
    withStandardWebhookSignature,
    type StandardWebhookReplayStore,
    type VerifiedStandardWebhook,
} from './standard-webhooks'

// isSimulated is the one thing from '../adapters/index' this module touches (the real import trips server-only in a
// test env). Mutable so the real-mode branch is exercisable too, as in webhook.test.ts.
const state = vi.hoisted(() => ({ fake: true }))
vi.mock('../adapters/index', () => ({
    get isSimulated() {
        return state.fake
    },
}))

const tmp = makeTestTmpDir('app-standard-webhooks-')
beforeAll(() => {
    process.env['APP_DATA_DIR'] = tmp
})
afterAll(() => {
    delete process.env['APP_DATA_DIR']
})
afterEach(() => {
    state.fake = true
    delete process.env['PARTNER_WEBHOOK_SECRET']
    delete process.env['PARTNER_WEBHOOK_SECRET_NEXT']
    __resetStandardWebhookReplayGuard()
    vi.useRealTimers()
})

// The worked example the Standard Webhooks specification publishes: an independent check of the signed string and
// the key decoding, not a value computed by the code under test.
const SPEC = {
    secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
    id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
    timestamp: '1614265330',
    body: '{"test": 2432232314}',
    signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
}
const SPEC_NOW = new Date(Number(SPEC.timestamp) * 1000)

const OTHER_SECRET = 'whsec_' + Buffer.from('another key of 24 bytes!').toString('base64')
const devSecret = () => 'whsec_' + Buffer.from(devWebhookSecret()).toString('base64')
const nowSeconds = () => Math.floor(Date.now() / 1000)

function signed(
    secret: string,
    opts: { id?: string; timestamp?: number; body?: string; prefix?: 'webhook' | 'svix' } = {},
): Request {
    const id = opts.id ?? 'msg_fixture_1'
    const timestamp = opts.timestamp ?? nowSeconds()
    const body = opts.body ?? '{"type":"docket.filed","data":{"id":"d1"}}'
    const prefix = opts.prefix ?? 'webhook'
    return new Request('http://localhost/api/webhooks/partner', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            [`${prefix}-id`]: id,
            [`${prefix}-timestamp`]: String(timestamp),
            [`${prefix}-signature`]: signStandardWebhook(secret, id, timestamp, body),
        },
        body,
    })
}

const ok = async () => Response.json({ ok: true })

describe('verifyStandardWebhookSignature (pure)', () => {
    const check = (overrides: Partial<Parameters<typeof verifyStandardWebhookSignature>[0]> = {}) =>
        verifyStandardWebhookSignature({
            id: SPEC.id,
            timestamp: SPEC.timestamp,
            signature: SPEC.signature,
            body: SPEC.body,
            secrets: [SPEC.secret],
            now: SPEC_NOW,
            ...overrides,
        })

    test('the specification’s example verifies, and signStandardWebhook reproduces its signature', () => {
        expect(check()).toEqual({ ok: true })
        expect(signStandardWebhook(SPEC.secret, SPEC.id, Number(SPEC.timestamp), SPEC.body)).toBe(SPEC.signature)
    })

    test('the whsec_ prefix is optional', () => {
        expect(check({ secrets: [SPEC.secret.slice('whsec_'.length)] })).toEqual({ ok: true })
    })

    test('a changed body, id or timestamp is a bad signature', () => {
        expect(check({ body: '{"test": 2432232315}' })).toEqual({ ok: false, reason: 'signature' })
        expect(check({ id: 'msg_other' })).toEqual({ ok: false, reason: 'signature' })
        expect(check({ timestamp: '1614265331' })).toEqual({ ok: false, reason: 'signature' })
    })

    test('the wrong secret, a secret that is not base64, and no secret at all never verify', () => {
        expect(check({ secrets: [OTHER_SECRET] })).toEqual({ ok: false, reason: 'signature' })
        expect(check({ secrets: ['whsec_not base64!'] })).toEqual({ ok: false, reason: 'signature' })
        expect(check({ secrets: ['whsec_'] })).toEqual({ ok: false, reason: 'signature' })
        expect(check({ secrets: [] })).toEqual({ ok: false, reason: 'signature' })
    })

    test('a stale or future timestamp is refused at the tolerance, either way', () => {
        const at = (ms: number) => check({ now: new Date(SPEC_NOW.getTime() + ms) })
        expect(at(5 * 60_000)).toEqual({ ok: true })
        expect(at(5 * 60_000 + 1)).toEqual({ ok: false, reason: 'stale' })
        expect(at(-5 * 60_000)).toEqual({ ok: true })
        expect(at(-5 * 60_000 - 1)).toEqual({ ok: false, reason: 'stale' })
        expect(check({ now: new Date(SPEC_NOW.getTime() + 60_000), toleranceMs: 30_000 })).toEqual({
            ok: false,
            reason: 'stale',
        })
    })

    test.each([
        ['a missing id', { id: null }],
        ['an empty id', { id: '' }],
        ['a missing timestamp', { timestamp: undefined }],
        ['a timestamp in milliseconds with a fraction', { timestamp: '1614265330.5' }],
        ['a negative timestamp', { timestamp: '-1614265330' }],
        ['a missing signature', { signature: null }],
        ['a signature with no version', { signature: 'g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=' }],
        ['only an asymmetric signature', { signature: SPEC.signature.replace('v1,', 'v1a,') }],
    ])('%s is malformed', (_name, overrides) => {
        expect(check(overrides)).toEqual({ ok: false, reason: 'malformed' })
    })

    test('several signatures, space-separated: any one valid is enough, and none valid is refused', () => {
        const wrong = signStandardWebhook(OTHER_SECRET, SPEC.id, Number(SPEC.timestamp), SPEC.body)
        expect(check({ signature: `${wrong} ${SPEC.signature}` })).toEqual({ ok: true })
        expect(check({ signature: `v1a,abc ${SPEC.signature}` })).toEqual({ ok: true })
        expect(check({ signature: `${wrong} v1,AAAA` })).toEqual({ ok: false, reason: 'signature' })
    })

    test('several secrets (a rotation): a signature under any of them verifies', () => {
        expect(check({ secrets: [OTHER_SECRET, SPEC.secret] })).toEqual({ ok: true })
        expect(check({ secrets: ['whsec_###', SPEC.secret] })).toEqual({ ok: true })
    })

    test('a signature of another length is a mismatch, not a timingSafeEqual throw', () => {
        expect(check({ signature: 'v1,AAAA' })).toEqual({ ok: false, reason: 'signature' })
    })

    test('the body is signed as bytes, so a Uint8Array body verifies the same', () => {
        expect(check({ body: new TextEncoder().encode(SPEC.body) })).toEqual({ ok: true })
    })
})

describe('withStandardWebhookSignature (simulated mode)', () => {
    test('a request signed with the dev secret reaches the handler, with its id, timestamp and body', async () => {
        const handler = vi.fn(async ({ webhook, request }: { webhook: VerifiedStandardWebhook; request: Request }) => {
            // The request's own body is still readable after verification.
            expect(await request.text()).toBe(webhook.body)
            return Response.json({ ok: true })
        })
        const guarded = withStandardWebhookSignature(handler, { secretEnv: 'PARTNER_WEBHOOK_SECRET' })
        const timestamp = nowSeconds()
        const response = await guarded(signed(devSecret(), { id: 'msg_a', timestamp, body: '{"n":1}' }))
        expect(response.status).toBe(200)
        expect(handler).toHaveBeenCalledOnce()
        expect(handler.mock.calls[0]![0].webhook).toEqual({ id: 'msg_a', timestamp, body: '{"n":1}' })
    })

    test('the env secret does not open a simulated route', async () => {
        process.env['PARTNER_WEBHOOK_SECRET'] = SPEC.secret
        const guarded = withStandardWebhookSignature(ok, { secretEnv: 'PARTNER_WEBHOOK_SECRET' })
        expect((await guarded(signed(SPEC.secret))).status).toBe(401)
    })

    test('a bad signature is an opaque 401 and the handler never runs', async () => {
        const handler = vi.fn(ok)
        const guarded = withStandardWebhookSignature(handler, { secretEnv: 'PARTNER_WEBHOOK_SECRET' })
        const response = await guarded(signed(OTHER_SECRET))
        expect(response.status).toBe(401)
        expect(await response.json()).toEqual({ error: 'unauthorized' })
        expect(handler).not.toHaveBeenCalled()
    })

    test('a stale request is a 401', async () => {
        const guarded = withStandardWebhookSignature(ok, { secretEnv: 'PARTNER_WEBHOOK_SECRET' })
        expect((await guarded(signed(devSecret(), { timestamp: nowSeconds() - 6 * 60 }))).status).toBe(401)
    })

    test('a request with no signature headers is a 401', async () => {
        const guarded = withStandardWebhookSignature(ok, { secretEnv: 'PARTNER_WEBHOOK_SECRET' })
        const bare = new Request('http://localhost/api/webhooks/partner', { method: 'POST', body: '{}' })
        expect((await guarded(bare)).status).toBe(401)
    })

    test('Svix’s header names verify when no webhook-* header is present', async () => {
        const guarded = withStandardWebhookSignature(ok, { secretEnv: 'PARTNER_WEBHOOK_SECRET' })
        expect((await guarded(signed(devSecret(), { prefix: 'svix' }))).status).toBe(200)
    })

    test('one webhook-* header selects that family: a Svix signature beside it does not count', async () => {
        const guarded = withStandardWebhookSignature(ok, { secretEnv: 'PARTNER_WEBHOOK_SECRET' })
        const request = signed(devSecret(), { prefix: 'svix' })
        request.headers.set('webhook-id', 'msg_decoy')
        expect((await guarded(request)).status).toBe(401)
    })
})

describe('replay', () => {
    const guard = () => withStandardWebhookSignature(ok, { secretEnv: 'PARTNER_WEBHOOK_SECRET' })

    test('the same signed message twice: the second is a 401', async () => {
        const guarded = guard()
        const timestamp = nowSeconds()
        expect((await guarded(signed(devSecret(), { id: 'msg_r', timestamp }))).status).toBe(200)
        expect((await guarded(signed(devSecret(), { id: 'msg_r', timestamp }))).status).toBe(401)
    })

    test('a retry, re-signed with a new timestamp, is accepted (the handler dedupes by id)', async () => {
        const guarded = guard()
        const timestamp = nowSeconds()
        expect((await guarded(signed(devSecret(), { id: 'msg_r', timestamp }))).status).toBe(200)
        expect((await guarded(signed(devSecret(), { id: 'msg_r', timestamp: timestamp + 5 }))).status).toBe(200)
    })

    test('a message is remembered until its signature stops verifying, even when it was signed in the future', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        const start = new Date('2026-11-27T12:00:00Z')
        vi.setSystemTime(start)
        const guarded = guard()
        // Four minutes ahead of the clock: fresh now, and fresh until nine minutes from now.
        const timestamp = Math.floor(start.getTime() / 1000) + 4 * 60
        const message = () => signed(devSecret(), { id: 'msg_future', timestamp })
        expect((await guarded(message())).status).toBe(200)
        vi.setSystemTime(start.getTime() + 8 * 60_000)
        expect((await guarded(message())).status).toBe(401)
        vi.setSystemTime(start.getTime() + 9 * 60_000 + 1)
        expect((await guarded(message())).status).toBe(401) // stale now, so the claim may go
    })

    test('a handler that throws or answers 5xx releases the message, so its resend is processed', async () => {
        let answer: 'throw' | 503 | 200 = 'throw'
        const guarded = withStandardWebhookSignature(
            async () => {
                if (answer === 'throw') throw new Error('downstream failed')
                return new Response(null, { status: answer })
            },
            { secretEnv: 'PARTNER_WEBHOOK_SECRET' },
        )
        const timestamp = nowSeconds()
        const message = () => signed(devSecret(), { id: 'msg_retry', timestamp })
        await expect(guarded(message())).rejects.toThrow('downstream failed')
        answer = 503
        expect((await guarded(message())).status).toBe(503)
        answer = 200
        expect((await guarded(message())).status).toBe(200)
        expect((await guarded(message())).status).toBe(401)
    })

    test('a 4xx from the handler keeps the claim', async () => {
        const guarded = withStandardWebhookSignature(async () => new Response(null, { status: 422 }), {
            secretEnv: 'PARTNER_WEBHOOK_SECRET',
        })
        const timestamp = nowSeconds()
        expect((await guarded(signed(devSecret(), { id: 'msg_4xx', timestamp }))).status).toBe(422)
        expect((await guarded(signed(devSecret(), { id: 'msg_4xx', timestamp }))).status).toBe(401)
    })

    test('a replay store the app passes is the one consulted, keyed by id and timestamp', async () => {
        const claims: Array<[string, number]> = []
        const store: StandardWebhookReplayStore = {
            claim: async (key, expiresAtMs) => {
                claims.push([key, expiresAtMs])
                return claims.length === 1
            },
            release: async () => {},
        }
        const guarded = withStandardWebhookSignature(ok, { secretEnv: 'PARTNER_WEBHOOK_SECRET', replayStore: store })
        const timestamp = nowSeconds()
        expect((await guarded(signed(devSecret(), { id: 'msg_s', timestamp }))).status).toBe(200)
        expect((await guarded(signed(devSecret(), { id: 'msg_s', timestamp }))).status).toBe(401)
        expect(claims[0]![0]).toBe(JSON.stringify(['msg_s', timestamp]))
    })

    test('verifyStandardWebhook claims the message as well', async () => {
        const timestamp = nowSeconds()
        const options = { secretEnv: 'PARTNER_WEBHOOK_SECRET' }
        await expect(verifyStandardWebhook(signed(devSecret(), { id: 'msg_v', timestamp }), options)).resolves.toEqual(
            expect.objectContaining({ id: 'msg_v', timestamp }),
        )
        await expect(verifyStandardWebhook(signed(devSecret(), { id: 'msg_v', timestamp }), options)).rejects.toThrow(
            AuthRequiredError,
        )
    })
})

describe('real mode', () => {
    test('the named variable’s secret verifies; the dev secret does not', async () => {
        state.fake = false
        process.env['PARTNER_WEBHOOK_SECRET'] = SPEC.secret
        const guarded = withStandardWebhookSignature(ok, { secretEnv: 'PARTNER_WEBHOOK_SECRET' })
        expect((await guarded(signed(SPEC.secret))).status).toBe(200)
        expect((await guarded(signed(devSecret()))).status).toBe(401)
    })

    test('an unset, empty or blank variable refuses every request', async () => {
        state.fake = false
        const guarded = withStandardWebhookSignature(ok, { secretEnv: 'PARTNER_WEBHOOK_SECRET' })
        expect((await guarded(signed(SPEC.secret))).status).toBe(401)
        process.env['PARTNER_WEBHOOK_SECRET'] = ''
        expect((await guarded(signed(SPEC.secret))).status).toBe(401)
        process.env['PARTNER_WEBHOOK_SECRET'] = '   '
        expect((await guarded(signed(SPEC.secret))).status).toBe(401)
    })

    test('rotation: two secrets in one variable, or one in each of two variables, both verify', async () => {
        state.fake = false
        process.env['PARTNER_WEBHOOK_SECRET'] = `${OTHER_SECRET} ${SPEC.secret}`
        const one = withStandardWebhookSignature(ok, { secretEnv: 'PARTNER_WEBHOOK_SECRET' })
        expect((await one(signed(SPEC.secret, { id: 'msg_1' }))).status).toBe(200)
        expect((await one(signed(OTHER_SECRET, { id: 'msg_2' }))).status).toBe(200)

        process.env['PARTNER_WEBHOOK_SECRET'] = SPEC.secret
        process.env['PARTNER_WEBHOOK_SECRET_NEXT'] = OTHER_SECRET
        const two = withStandardWebhookSignature(ok, {
            secretEnv: ['PARTNER_WEBHOOK_SECRET', 'PARTNER_WEBHOOK_SECRET_NEXT'],
        })
        expect((await two(signed(SPEC.secret, { id: 'msg_3' }))).status).toBe(200)
        expect((await two(signed(OTHER_SECRET, { id: 'msg_4' }))).status).toBe(200)
        delete process.env['PARTNER_WEBHOOK_SECRET']
        expect((await two(signed(SPEC.secret, { id: 'msg_5' }))).status).toBe(401)
    })
})

describe('options', () => {
    test.each([[''], ['partner_secret'], ['NEXT_PUBLIC_PARTNER_SECRET'], [[]], [['GOOD_NAME', 'bad-name']]])(
        'a secretEnv of %j throws when the route is built',
        (secretEnv) => {
            expect(() => withStandardWebhookSignature(ok, { secretEnv })).toThrow(TypeError)
        },
    )

    test('signStandardWebhook refuses a secret that is not base64', () => {
        expect(() => signStandardWebhook('whsec_###', 'msg', 1, '')).toThrow(TypeError)
    })
})
