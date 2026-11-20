import { beforeEach, describe, expect, test, vi } from 'vitest'

const h = vi.hoisted(() => ({ acceptInvite: vi.fn() }))
vi.mock('@sssb/kit/adapters/index', () => ({ isSimulated: true, db: {} }))
vi.mock('@sssb/kit/adapters/fake/auth', () => ({ acceptInvite: h.acceptInvite }))
vi.mock('@sssb/kit/db/tenant-lookup', () => ({ tenantIdForSlug: async () => null }))
vi.mock('@sssb/kit/db/agreements', () => ({ listAgreementsForTenant: vi.fn(), recordAcceptance: vi.fn() }))

async function post(name: unknown): Promise<Response> {
    const { POST } = await import('./route')
    return POST(
        new Request('http://localhost/api/auth/accept-invite', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ inviteId: 'invite-one', name }),
        }),
    )
}

beforeEach(() => {
    h.acceptInvite.mockReset()
    h.acceptInvite.mockResolvedValue({ id: 'person-bob', tenantSlug: 'northwind' })
})

describe('POST /api/auth/accept-invite: the name is held to the auth port limit', () => {
    test.each([
        ['blank', '   '],
        ['over 256 characters', 'x'.repeat(257)],
        ['not a string', 5],
    ])('400 for a name that is %s, and no one joins', async (_label, name) => {
        expect((await post(name)).status).toBe(400)
        expect(h.acceptInvite).not.toHaveBeenCalled()
    })

    test('a 256-character name is accepted', async () => {
        expect((await post('x'.repeat(256))).status).toBe(200)
        expect(h.acceptInvite).toHaveBeenCalledTimes(1)
    })
})
