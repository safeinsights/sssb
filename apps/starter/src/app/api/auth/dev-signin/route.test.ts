import { beforeEach, describe, expect, test, vi } from 'vitest'
import { POST } from './route'

const h = vi.hoisted(() => ({ devSignIn: vi.fn() }))
vi.mock('@sssb/kit/adapters/index', () => ({ isSimulated: true }))
vi.mock('@sssb/kit/adapters/fake/auth', () => ({ devSignIn: h.devSignIn }))

function post(contentType: string): Promise<Response> {
    return POST(
        new Request('http://localhost/api/auth/dev-signin', {
            method: 'POST',
            headers: { 'content-type': contentType },
            body: JSON.stringify({ personId: 'person-one' }),
        }),
    )
}

beforeEach(() => {
    h.devSignIn.mockReset()
})

describe('POST /api/auth/dev-signin (simulated mode)', () => {
    test('signs in on a JSON request', async () => {
        expect((await post('application/json')).status).toBe(200)
        expect(h.devSignIn).toHaveBeenCalledWith('person-one')
    })

    test.each(['text/plain', 'application/x-www-form-urlencoded'])(
        'answers 415 to %s, which another origin can send without a preflight, and signs no one in',
        async (contentType) => {
            const response = await post(contentType)
            expect(response.status).toBe(415)
            expect(h.devSignIn).not.toHaveBeenCalled()
        },
    )
})
