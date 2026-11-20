import { beforeEach, describe, expect, test, vi } from 'vitest'

const h = vi.hoisted(() => ({ update: vi.fn() }))
vi.mock('@sssb/kit/adapters/index', () => ({ isSimulated: true }))
vi.mock('@sssb/kit/adapters/fake/auth', () => ({
    listAllPeople: () => [{ id: 'person-admin' }],
    findInvite: (id: string) => (id === 'invite-one' ? { id } : undefined),
}))
vi.mock('@sssb/kit/adapters/fake/simulator', () => ({ updatePersonState: h.update }))

function post(person: string): Promise<Response> {
    return import('./route').then(({ POST }) =>
        POST(
            new Request('http://localhost/api/simulator/mail/seen', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ person }),
            }),
        ),
    )
}

beforeEach(() => {
    h.update.mockReset()
})

describe('POST /api/simulator/mail/seen writes only a key for someone in the world', () => {
    test('a known person and a known invite are marked seen', async () => {
        expect((await post('person:person-admin')).status).toBe(200)
        expect((await post('invited:invite-one')).status).toBe(200)
        expect(h.update).toHaveBeenCalledTimes(2)
    })

    test.each(['person:zzz-not-a-person', 'invited:no-such-invite'])(
        '%s is a 400 and writes nothing',
        async (person) => {
            const response = await post(person)
            expect(response.status).toBe(400)
            expect(await response.json()).toEqual({ error: 'unknown person' })
            expect(h.update).not.toHaveBeenCalled()
        },
    )
})

describe('POST /api/simulator/mail/seen, a JSON request with a bad body', () => {
    test.each([['{'], ['null']])('400, never a 500, for %s', async (body) => {
        const { POST } = await import('./route')
        const response = await POST(
            new Request('http://localhost/api/simulator/mail/seen', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body,
            }),
        )
        expect(response.status).toBe(400)
        expect(h.update).not.toHaveBeenCalled()
    })
})
