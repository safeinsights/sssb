import { beforeEach, describe, expect, test, vi } from 'vitest'
import { POST } from './route'

const h = vi.hoisted(() => ({ signOut: vi.fn() }))
vi.mock('@sssb/kit/adapters/index', () => ({ auth: { signOut: h.signOut } }))

beforeEach(() => {
    h.signOut.mockReset()
})

const post = (headers: Record<string, string> = {}) =>
    POST(new Request('http://localhost/api/auth/signout', { method: 'POST', headers }))

describe('POST /api/auth/signout', () => {
    test("ends the session for a JSON request, the kind only this app's own pages send", async () => {
        const response = await post({ 'content-type': 'application/json' })
        expect(response.status).toBe(200)
        expect(h.signOut).toHaveBeenCalledTimes(1)
    })

    test.each([
        ['no content type', {}],
        ['a form post', { 'content-type': 'application/x-www-form-urlencoded' }],
        ['text/plain', { 'content-type': 'text/plain' }],
    ])(
        'refuses %s, which another site could send with the session cookie, and signs nobody out',
        async (_, headers) => {
            const response = await post(headers)
            expect(response.status).toBe(415)
            expect(h.signOut).not.toHaveBeenCalled()
        },
    )
})
