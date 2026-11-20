import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AuthUser } from '@sssb/kit/ports/auth'
import { POST } from './route'

// Real authorize (pure abilities) runs; the adapters, lookups and the invite seam are faked.
const h = vi.hoisted(() => ({
    requireUser: vi.fn(),
    listMembers: vi.fn(),
    tenantIdForSlug: vi.fn(),
    orgIdForSlug: vi.fn(),
    sendOrgInvite: vi.fn(),
}))
vi.mock('@sssb/kit/adapters/index', () => ({
    auth: { requireUser: h.requireUser, listMembers: h.listMembers },
    db: {},
}))
vi.mock('@sssb/kit/db/tenant-lookup', () => ({ tenantIdForSlug: h.tenantIdForSlug }))
vi.mock('@sssb/kit/db/org-lookup', () => ({ orgIdForSlug: h.orgIdForSlug }))
vi.mock('@sssb/kit/server-lib/invite', () => ({ sendOrgInvite: h.sendOrgInvite }))
vi.mock('@app/seed', () => ({ findOrg: () => ({ name: 'Frontline' }) }))

const ADMIN: AuthUser = {
    id: 'user-ada',
    name: 'Dana Okoye',
    email: 'dana.okoye@example.test',
    role: 'admin',
    locale: 'en',
    tenantSlug: 'northwind',
    orgSlug: 'frontline',
    restricted: false,
}

function post(body: string): Promise<Response> {
    return POST(new Request('http://localhost/api/org/invite', { method: 'POST', body }))
}

beforeEach(() => {
    for (const fn of Object.values(h)) fn.mockReset()
    h.requireUser.mockResolvedValue(ADMIN)
    h.listMembers.mockResolvedValue([])
    h.tenantIdForSlug.mockResolvedValue('tenant-northwind')
    h.orgIdForSlug.mockResolvedValue('org-frontline')
    h.sendOrgInvite.mockResolvedValue({ id: 'invite-one' })
})

describe('POST /api/org/invite', () => {
    test('200 for one address', async () => {
        const response = await post(JSON.stringify({ email: ' invitee@example.test ', role: 'member' }))
        expect(response.status).toBe(200)
        expect(h.sendOrgInvite).toHaveBeenCalledWith(expect.objectContaining({ email: 'invitee@example.test' }))
    })

    test.each([
        'invitee@example.test, attacker@evil.example',
        'invitee@example.test;attacker@evil.example',
        'invitee@example.test attacker@evil.example',
        'in vitee@example.test',
        'a@b@example.test',
        'no-at-sign.example.test',
        'nobody@localhost',
        'a<b@c.d>',
        'Name <b@c.d>',
        '"b"@c.d',
        'b@c.d(comment)',
    ])('400 for %j, which is not exactly one address', async (email) => {
        const response = await post(JSON.stringify({ email, role: 'member' }))
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'invalid email' })
        expect(h.sendOrgInvite).not.toHaveBeenCalled()
    })

    test.each([['null'], ['{'], ['[]']])('400 for a body %s that is not an object', async (body) => {
        expect((await post(body)).status).toBe(400)
        expect(h.sendOrgInvite).not.toHaveBeenCalled()
    })
})
