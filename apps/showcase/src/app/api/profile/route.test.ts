import { beforeEach, describe, expect, test, vi } from 'vitest'
import { POST } from './route'

import { AuthRequiredError } from '@sssb/kit/ports/errors'

const h = vi.hoisted(() => ({ updateProfile: vi.fn(), requireUser: vi.fn() }))
vi.mock('@sssb/kit/adapters/index', () => ({ auth: { updateProfile: h.updateProfile, requireUser: h.requireUser } }))

function post(body: string): Promise<Response> {
    return POST(new Request('http://localhost/api/profile', { method: 'POST', body }))
}

beforeEach(() => {
    h.updateProfile.mockReset()
    h.requireUser.mockReset()
    h.requireUser.mockResolvedValue({ id: 'user-ada' })
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
        ['over-long', { name: 'x'.repeat(257) }],
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

describe('POST /api/profile, signed out', () => {
    test.each([['{'], [JSON.stringify({ name: { a: 1 } })]])('401 before the body %s is read', async (body) => {
        h.requireUser.mockRejectedValue(new AuthRequiredError())
        expect((await post(body)).status).toBe(401)
        expect(h.updateProfile).not.toHaveBeenCalled()
    })
})

describe('POST /api/profile, the name limit', () => {
    test("a 256-character name is the auth port's limit, and is accepted", async () => {
        expect((await post(JSON.stringify({ name: 'x'.repeat(256) }))).status).toBe(200)
    })
})
