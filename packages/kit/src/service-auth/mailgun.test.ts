import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { makeTestTmpDir } from '../testing/tmp-dir'
import { devWebhookSecret } from '../adapters/fake/service-auth'
import { mailgunSignature } from '../core/webhook-signing'
import { AuthRequiredError } from '../ports/errors'
import { __resetMailgunReplayGuard, forgetMailgunToken, verifyMailgunWebhook } from './mailgun'

// isSimulated is the one thing from '../adapters/index' mailgun.ts touches (real import trips server-only in a
// test env). Mutable so the env-key real-mode branch is exercisable too — the webhook.test.ts pattern.
const state = vi.hoisted(() => ({ fake: true }))
vi.mock('../adapters/index', () => ({
    get isSimulated() {
        return state.fake
    },
}))

const tmp = makeTestTmpDir('app-mailgun-')
beforeAll(() => {
    process.env['APP_DATA_DIR'] = tmp
})
afterAll(() => {
    delete process.env['APP_DATA_DIR']
})
afterEach(() => {
    state.fake = true
    delete process.env['MAILGUN_WEBHOOK_SIGNING_KEY']
    __resetMailgunReplayGuard()
})

const TS = '1700000000'
const NOW = new Date(Number(TS) * 1000)
let tokenSeq = 0
/** A fresh token per call so the replay guard doesn't reject an intentionally-valid case. */
function uniqueToken(): string {
    return `token-${tokenSeq++}-${Math.random().toString(36).slice(2)}`
}

describe('verifyMailgunWebhook (simulated mode, dev secret)', () => {
    test('a correctly signed request passes', () => {
        const token = uniqueToken()
        const signature = mailgunSignature(devWebhookSecret(), TS, token)
        expect(() => verifyMailgunWebhook({ timestamp: TS, token, signature }, NOW)).not.toThrow()
    })

    test('a wrong signature is rejected', () => {
        const token = uniqueToken()
        const signature = mailgunSignature('the-wrong-key', TS, token)
        expect(() => verifyMailgunWebhook({ timestamp: TS, token, signature }, NOW)).toThrow(AuthRequiredError)
    })

    test('a stale timestamp is rejected', () => {
        const token = uniqueToken()
        const signature = mailgunSignature(devWebhookSecret(), TS, token)
        const later = new Date((Number(TS) + 10 * 60) * 1000)
        expect(() => verifyMailgunWebhook({ timestamp: TS, token, signature }, later)).toThrow(AuthRequiredError)
    })

    test('a replayed token (same token twice in the window) is rejected the second time', () => {
        const token = uniqueToken()
        const signature = mailgunSignature(devWebhookSecret(), TS, token)
        expect(() => verifyMailgunWebhook({ timestamp: TS, token, signature }, NOW)).not.toThrow()
        expect(() => verifyMailgunWebhook({ timestamp: TS, token, signature }, NOW)).toThrow(AuthRequiredError)
    })
})

describe('verifyMailgunWebhook (real mode, env key)', () => {
    test('the configured MAILGUN_WEBHOOK_SIGNING_KEY passes', () => {
        state.fake = false
        process.env['MAILGUN_WEBHOOK_SIGNING_KEY'] = 'real-mg-key-0123456789'
        const token = uniqueToken()
        const signature = mailgunSignature('real-mg-key-0123456789', TS, token)
        expect(() => verifyMailgunWebhook({ timestamp: TS, token, signature }, NOW)).not.toThrow()
    })

    test('no configured key rejects everything', () => {
        state.fake = false
        delete process.env['MAILGUN_WEBHOOK_SIGNING_KEY']
        const token = uniqueToken()
        const signature = mailgunSignature('whatever', TS, token)
        expect(() => verifyMailgunWebhook({ timestamp: TS, token, signature }, NOW)).toThrow(AuthRequiredError)
    })
})

describe('replay guard vs a sender whose clock runs ahead of ours', () => {
    test('a token is refused for as long as its signature is still fresh', () => {
        // The sender's clock is 4 minutes ahead (inside the 5-minute tolerance, both directions).
        const firstSeen = new Date((Number(TS) - 240) * 1000)
        const token = uniqueToken()
        const signature = mailgunSignature(devWebhookSecret(), TS, token)
        verifyMailgunWebhook({ timestamp: TS, token, signature }, firstSeen)
        // 5m01s later by OUR clock, but the timestamp is only 61s old: the signature is still fresh.
        const replayAt = new Date(firstSeen.getTime() + 301_000)
        expect(() => verifyMailgunWebhook({ timestamp: TS, token, signature }, replayAt)).toThrow(AuthRequiredError)
    })
})

describe('forgetMailgunToken', () => {
    test('a forgotten token (its handler failed) verifies again, so the retry is processed', () => {
        const token = uniqueToken()
        const signature = mailgunSignature(devWebhookSecret(), TS, token)
        verifyMailgunWebhook({ timestamp: TS, token, signature }, NOW)
        forgetMailgunToken(token)
        expect(() => verifyMailgunWebhook({ timestamp: TS, token, signature }, NOW)).not.toThrow()
        expect(() => verifyMailgunWebhook({ timestamp: TS, token, signature }, NOW)).toThrow(AuthRequiredError)
    })
})
