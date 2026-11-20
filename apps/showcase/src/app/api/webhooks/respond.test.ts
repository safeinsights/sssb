import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AuthRequiredError } from '@sssb/kit/ports/errors'
import { withMailgunSignature } from './respond'

const h = vi.hoisted(() => ({ verify: vi.fn(), forget: vi.fn() }))
vi.mock('@sssb/kit/service-auth/mailgun', () => ({ verifyMailgunWebhook: h.verify, forgetMailgunToken: h.forget }))
vi.mock('@sssb/kit/service-auth/webhook', () => ({ verifyWebhookCaller: vi.fn() }))

function post(): Request {
    const form = new FormData()
    form.set('timestamp', '1700000000')
    form.set('token', 'tok-1')
    form.set('signature', 'sig')
    return new Request('http://localhost/api/webhooks/email', { method: 'POST', body: form })
}

beforeEach(() => {
    h.verify.mockReset()
    h.forget.mockReset()
})

describe('withMailgunSignature: the replay token of an unprocessed message', () => {
    test('is kept when the handler succeeds', async () => {
        const response = await withMailgunSignature(async () => Response.json({ ok: true }))(post())
        expect(response.status).toBe(200)
        expect(h.forget).not.toHaveBeenCalled()
    })

    test('is forgotten when the handler answers 5xx, so the retry is processed', async () => {
        const response = await withMailgunSignature(async () => new Response(null, { status: 503 }))(post())
        expect(response.status).toBe(503)
        expect(h.forget).toHaveBeenCalledWith('tok-1')
    })

    test('is forgotten when the handler throws', async () => {
        const failing = withMailgunSignature(async () => {
            throw new Error('database down')
        })
        await expect(failing(post())).rejects.toThrow('database down')
        expect(h.forget).toHaveBeenCalledWith('tok-1')
    })

    test('is never touched when verification fails', async () => {
        h.verify.mockImplementation(() => {
            throw new AuthRequiredError()
        })
        const handler = vi.fn()
        const response = await withMailgunSignature(handler)(post())
        expect(response.status).toBe(401)
        expect(handler).not.toHaveBeenCalled()
        expect(h.forget).not.toHaveBeenCalled()
    })
})
