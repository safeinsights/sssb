import { beforeEach, describe, expect, test, vi } from 'vitest'
import { POST } from './route'

const h = vi.hoisted(() => ({ setActiveOrg: vi.fn() }))
vi.mock('@sssb/kit/adapters/index', () => ({ auth: { setActiveOrg: h.setActiveOrg } }))

function post(body: string): Promise<Response> {
    return POST(new Request('http://localhost/api/auth/org', { method: 'POST', body }))
}

beforeEach(() => {
    h.setActiveOrg.mockReset()
})

describe('POST /api/auth/org', () => {
    test('switches to the named org', async () => {
        expect((await post(JSON.stringify({ orgSlug: 'lakeside' }))).status).toBe(200)
        expect(h.setActiveOrg).toHaveBeenCalledWith('lakeside')
    })

    test.each([['{'], ['null'], ['[]'], [JSON.stringify({ orgSlug: 5 })], [JSON.stringify({})]])(
        '400, never a 500, for the body %s',
        async (body) => {
            const response = await post(body)
            expect(response.status).toBe(400)
            expect(await response.json()).toEqual({ error: 'invalid-payload' })
            expect(h.setActiveOrg).not.toHaveBeenCalled()
        },
    )
})
