import { beforeEach, describe, expect, test, vi } from 'vitest'
import { POST } from './route'

import { AuthRequiredError } from '@sssb/kit/ports/errors'

const h = vi.hoisted(() => ({ setActiveOrg: vi.fn(), requireUser: vi.fn() }))
vi.mock('@sssb/kit/adapters/index', () => ({ auth: { setActiveOrg: h.setActiveOrg, requireUser: h.requireUser } }))

function post(body: string): Promise<Response> {
    return POST(new Request('http://localhost/api/auth/org', { method: 'POST', body }))
}

beforeEach(() => {
    h.setActiveOrg.mockReset()
    h.requireUser.mockReset()
    h.requireUser.mockResolvedValue({ id: 'user-one' })
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

describe('POST /api/auth/org, signed out', () => {
    test.each([['{'], [JSON.stringify({ orgSlug: 5 })]])('401 before the body %s is read', async (body) => {
        h.requireUser.mockRejectedValue(new AuthRequiredError())
        expect((await post(body)).status).toBe(401)
        expect(h.setActiveOrg).not.toHaveBeenCalled()
    })
})
