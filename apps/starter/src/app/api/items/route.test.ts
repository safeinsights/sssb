import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AuthUser } from '@sssb/kit/ports/auth'
import { GET } from './route'

// Real authorize (pure abilities) runs — only the adapters and data modules are faked. Low-entropy
// fixture ids/slugs (gitleaks): no hex, no UUIDs.
const h = vi.hoisted(() => ({
    requireUser: vi.fn(),
    tenantIdForSlug: vi.fn(),
    orgIdForSlug: vi.fn(),
    listItems: vi.fn(),
}))
vi.mock('@sssb/kit/adapters/index', () => ({ auth: { requireUser: h.requireUser }, db: {} }))
vi.mock('@sssb/kit/db/tenant-lookup', () => ({ tenantIdForSlug: h.tenantIdForSlug }))
vi.mock('@sssb/kit/db/org-lookup', () => ({ orgIdForSlug: h.orgIdForSlug }))
vi.mock('@/domain/db/items', () => ({ listItems: h.listItems }))

function user(overrides: Partial<AuthUser> = {}): AuthUser {
    return {
        id: 'user-ada',
        name: 'Dana Okoye',
        email: 'dana.okoye@example.test',
        role: 'member',
        locale: 'en',
        tenantSlug: 'northwind',
        orgSlug: 'frontline',
        restricted: false,
        ...overrides,
    }
}

const listRequest = (query = '') => new Request(`http://localhost/api/items${query}`)

beforeEach(() => {
    for (const fn of Object.values(h)) fn.mockReset()
    h.requireUser.mockResolvedValue(user())
    h.tenantIdForSlug.mockResolvedValue('tenant-northwind')
    h.orgIdForSlug.mockResolvedValue('org-frontline')
    h.listItems.mockResolvedValue({ items: [], nextCursor: null })
})

describe('GET /api/items (list)', () => {
    test('returns one page of the active org items, tenant- and org-scoped', async () => {
        h.listItems.mockResolvedValue({ items: [{ id: 'item-1', title: 'First' }], nextCursor: null })

        const response = await GET(listRequest())

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ items: [{ id: 'item-1', title: 'First' }], nextCursor: null })
        expect(h.listItems).toHaveBeenCalledWith({}, 'tenant-northwind', 'org-frontline', {
            after: null,
            limit: expect.any(Number),
        })
    })

    test('a restricted member may still READ the list (Item read = sameOrg; only writes need !restricted)', async () => {
        h.requireUser.mockResolvedValue(user({ role: 'restricted', restricted: true }))

        const response = await GET(listRequest())

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ items: [], nextCursor: null })
    })

    test('403 for a person with the role none: no standing in the org, so no org-scoped read', async () => {
        h.requireUser.mockResolvedValue(user({ role: 'none', restricted: true }))

        expect((await GET(listRequest())).status).toBe(403)
        expect(h.listItems).not.toHaveBeenCalled()
    })
})
