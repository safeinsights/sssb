import { beforeEach, describe, expect, test, vi } from 'vitest'
import { POST } from './route'

const h = vi.hoisted(() => ({ requireUser: vi.fn(), withTenant: vi.fn() }))
vi.mock('@sssb/kit/adapters/index', () => ({ auth: { requireUser: h.requireUser }, db: { withTenant: h.withTenant } }))

function post(body: string): Promise<Response> {
    return POST(new Request('http://localhost/api/items', { method: 'POST', body }))
}

beforeEach(() => {
    h.requireUser.mockReset()
    h.withTenant.mockReset()
    h.requireUser.mockResolvedValue({ id: 'user-one', tenantSlug: 'acme', orgSlug: 'team', restricted: false })
})

describe('POST /api/items: a malformed body is a 400, never a 500', () => {
    test.each([['{'], ['null'], ['[]']])('a body %s that is not an object', async (body) => {
        expect((await post(body)).status).toBe(400)
        expect(h.withTenant).not.toHaveBeenCalled()
    })

    test.each([[JSON.stringify({ title: 5 })], [JSON.stringify({ title: '  ' })], [JSON.stringify({})]])(
        'a title that is not a non-empty string: %s',
        async (body) => {
            const response = await post(body)
            expect(response.status).toBe(400)
            expect(await response.json()).toEqual({ error: 'empty item' })
            expect(h.withTenant).not.toHaveBeenCalled()
        },
    )
})
