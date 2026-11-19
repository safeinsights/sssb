// @ts-check
import { Buffer } from 'node:buffer'
import { TextEncoder } from 'node:util'
import { describe, expect, it } from 'vitest'
import { CRON_PATH, cronEvent, tick } from './assets/scheduled-tick/index.mjs'

const NOW = new Date('2026-11-19T03:30:00.000Z')
const HOST = 'abc123.lambda-url.us-east-1.on.aws'

/**
 * A tick against stand-ins for Secrets Manager and the server, recording what the server was sent.
 * @param {{ secret?: string, answer?: object, functionError?: string }} options
 */
function run({ secret = 's3cret', answer = { statusCode: 200, body: '{"ok":true,"spawned":1}' }, functionError } = {}) {
    /** @type {unknown[]} */
    const sent = []
    const result = tick({
        readSecret: async () => secret,
        invoke: async (payload) => {
            sent.push(JSON.parse(payload))
            return {
                ...(functionError && { FunctionError: functionError }),
                Payload: new TextEncoder().encode(JSON.stringify(answer)),
            }
        },
        host: HOST,
        requestId: 'req-1',
        now: NOW,
    })
    return { result, sent }
}

describe('the scheduled tick', () => {
    it('POSTs the cron route, as a Function URL would, with the secret as the bearer', () => {
        const event = cronEvent({ secret: 's3cret', host: HOST, requestId: 'req-1', now: NOW })
        expect(event).toMatchObject({
            version: '2.0',
            rawPath: '/api/webhooks/cron',
            rawQueryString: '',
            headers: { authorization: 'Bearer s3cret', host: HOST },
            requestContext: {
                domainName: HOST,
                http: { method: 'POST', path: CRON_PATH },
                requestId: 'req-1',
                timeEpoch: NOW.getTime(),
            },
            body: '{}',
            isBase64Encoded: false,
        })
    })

    it("sends that event to the server and returns the route's body", async () => {
        const { result, sent } = run()
        await expect(result).resolves.toBe('{"ok":true,"spawned":1}')
        expect(sent).toEqual([cronEvent({ secret: 's3cret', host: HOST, requestId: 'req-1', now: NOW })])
    })

    it('decodes a base64 body', async () => {
        const body = Buffer.from('{"ok":true}').toString('base64')
        await expect(run({ answer: { statusCode: 200, body, isBase64Encoded: true } }).result).resolves.toBe(
            '{"ok":true}',
        )
    })

    it('fails, never quietly, when the route refuses it, the server fails, or there is no secret to send', async () => {
        await expect(run({ answer: { statusCode: 401, body: '{"error":"unauthorized"}' } }).result).rejects.toThrow(
            /the cron route answered 401/,
        )
        await expect(run({ functionError: 'Unhandled', answer: { errorMessage: 'boom' } }).result).rejects.toThrow(
            /the server failed the tick \(Unhandled\): .*boom/,
        )
        const missing = run({ secret: '' })
        await expect(missing.result).rejects.toThrow(/the webhook secret has no string value/)
        expect(missing.sent).toEqual([])
    })
})
