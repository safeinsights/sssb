import { beforeEach, describe, expect, test, vi } from 'vitest'
import { InvalidTransitionError } from '@sssb/kit/core/state-machine'
import { AuthRequiredError, NotFoundError } from '@sssb/kit/ports/errors'
import { POST } from './route'

const h = vi.hoisted(() => ({ verify: vi.fn(), record: vi.fn(), notifyJobTerminal: vi.fn(), makeNotifyDeps: vi.fn() }))
vi.mock('@sssb/kit/adapters/index', () => ({ db: {}, auth: {} }))
vi.mock('@sssb/kit/service-auth/webhook', () => ({ verifyWebhookCaller: h.verify }))
vi.mock('@sssb/kit/db/jobs', () => ({ recordWebhookCompletion: h.record }))
// The notification fan-out is mocked away — the route test isolates the completion path, not
// the notify seam (mirrors how the escalation route test mocks enqueueWebhookEvent).
vi.mock('@sssb/kit/server-lib/notify', () => ({ notifyJobTerminal: h.notifyJobTerminal }))
vi.mock('@sssb/kit/server-lib/notify-deps', () => ({ makeNotifyDeps: h.makeNotifyDeps }))

function post(body: unknown): Promise<Response> {
    const request = new Request('http://localhost/api/webhooks/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
    // No dynamic segment; Next passes an (unused) empty params context.
    return POST(request, { params: Promise.resolve<Record<string, string>>({}) })
}

const valid = {
    jobId: 'd0000000-0000-4000-8000-000000000001',
    tenantId: 'e0000000-0000-4000-8000-000000000001',
    status: 'completed' as const,
}

beforeEach(() => {
    h.verify.mockReset()
    h.record.mockReset()
    h.notifyJobTerminal.mockReset()
    h.makeNotifyDeps.mockReset()
    h.verify.mockReturnValue(undefined)
    h.notifyJobTerminal.mockResolvedValue(undefined)
    h.makeNotifyDeps.mockResolvedValue({})
})

describe('POST /api/webhooks/jobs', () => {
    test('401 when the shared secret is wrong', async () => {
        h.verify.mockImplementation(() => {
            throw new AuthRequiredError()
        })

        const response = await post(valid)

        expect(response.status).toBe(401)
        expect(h.record).not.toHaveBeenCalled()
    })

    test('400 on a malformed payload', async () => {
        expect((await post({ tenantId: 'e0000000-0000-4000-8000-000000000001', status: 'completed' })).status).toBe(400) // no jobId
        expect(
            (
                await post({
                    jobId: 'd0000000-0000-4000-8000-000000000001',
                    tenantId: 'e0000000-0000-4000-8000-000000000001',
                    status: 'weird',
                })
            ).status,
        ).toBe(400) // bad status
        expect(
            (
                await post({
                    jobId: 'd0000000-0000-4000-8000-000000000001',
                    tenantId: 'e0000000-0000-4000-8000-000000000001',
                    status: 'completed',
                    resultKey: 5,
                })
            ).status,
        ).toBe(400)
        expect(h.record).not.toHaveBeenCalled()
    })

    test("400 when resultKey escapes the named tenant's namespace", async () => {
        const planted = { ...valid, resultKey: 'exports/other-tenant/j.csv' }
        expect((await post(planted)).status).toBe(400)
        expect(h.record).not.toHaveBeenCalled()
    })

    test('200 { idempotent: false } when the completion is newly applied', async () => {
        h.record.mockResolvedValue('applied')

        const response = await post({ ...valid, resultKey: 'exports/e0000000-0000-4000-8000-000000000001/x.csv' })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true, idempotent: false })
        expect(h.record).toHaveBeenCalledWith(
            {},
            {
                tenantId: 'e0000000-0000-4000-8000-000000000001',
                jobId: 'd0000000-0000-4000-8000-000000000001',
                status: 'completed',
                resultKey: 'exports/e0000000-0000-4000-8000-000000000001/x.csv',
                error: undefined,
            },
        )
    })

    test('200 { idempotent: true } on a redelivery', async () => {
        h.record.mockResolvedValue('idempotent')

        const response = await post(valid)

        expect(await response.json()).toEqual({ ok: true, idempotent: true })
    })

    test('404 for an unknown job', async () => {
        h.record.mockRejectedValue(new NotFoundError())

        expect((await post(valid)).status).toBe(404)
    })

    test('409 with from/to on an illegal transition', async () => {
        h.record.mockRejectedValue(new InvalidTransitionError('completed', 'failed'))

        const response = await post({ ...valid, status: 'failed' })

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: 'invalid-transition', from: 'completed', to: 'failed' })
    })
})

describe('ids that cannot be rows, or a malformed body', () => {
    test('a body that does not parse is a 400', async () => {
        const request = new Request('http://localhost/api/webhooks/jobs', { method: 'POST', body: '{' })
        expect((await POST(request, { params: Promise.resolve<Record<string, string>>({}) })).status).toBe(400)
    })

    test('a job id or tenant id that is not a uuid is the documented 404 for an unknown job, never a 500', async () => {
        expect((await post({ ...valid, jobId: 'x' })).status).toBe(404)
        expect((await post({ ...valid, tenantId: 'y', resultKey: undefined })).status).toBe(404)
        expect(h.record).not.toHaveBeenCalled()
    })
})
