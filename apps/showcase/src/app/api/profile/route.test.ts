import { beforeEach, describe, expect, test, vi } from 'vitest'
import { POST } from './route'

const h = vi.hoisted(() => ({ updateProfile: vi.fn() }))
vi.mock('@sssb/kit/adapters/index', () => ({ auth: { updateProfile: h.updateProfile } }))

function post(body: string): Promise<Response> {
    return POST(new Request('http://localhost/api/profile', { method: 'POST', body }))
}

beforeEach(() => {
    h.updateProfile.mockReset()
    h.updateProfile.mockImplementation(async (update: unknown) => ({ id: 'user-ada', ...(update as object) }))
})

describe('POST /api/profile', () => {
    test('200 with a trimmed name and a known locale', async () => {
        const response = await post(JSON.stringify({ name: '  Dana Okoye ', locale: 'es' }))
        expect(response.status).toBe(200)
        expect(h.updateProfile).toHaveBeenCalledWith({ name: 'Dana Okoye', locale: 'es' })
    })

    test('an absent name leaves it unchanged, and an unknown locale is ignored', async () => {
        expect((await post(JSON.stringify({ locale: 'xx' }))).status).toBe(200)
        expect(h.updateProfile).toHaveBeenCalledWith({ name: undefined, locale: undefined })
    })

    test.each([
        ['an object', { name: { a: 1 } }],
        ['a number', { name: 5 }],
        ['empty', { name: '   ' }],
        ['over-long', { name: 'x'.repeat(121) }],
    ])('400 for a name that is %s, and the provider is never called', async (_label, body) => {
        const response = await post(JSON.stringify(body))
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'invalid-name' })
        expect(h.updateProfile).not.toHaveBeenCalled()
    })

    test.each([['{'], ['null'], ['[]']])('400 for a body %s that is not an object', async (body) => {
        expect((await post(body)).status).toBe(400)
        expect(h.updateProfile).not.toHaveBeenCalled()
    })
})
