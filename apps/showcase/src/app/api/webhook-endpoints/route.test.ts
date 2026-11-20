import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AuthUser } from '@sssb/kit/ports/auth'
import { GET } from './route'

// Real authorize (pure abilities) runs — only the adapters and data modules are faked. Low-entropy
// fixture ids/slugs (gitleaks): no hex, no UUIDs.
const h = vi.hoisted(() => ({
    requireUser: vi.fn(),
    tenantIdForSlug: vi.fn(),
    orgIdForSlug: vi.fn(),
    listEndpointsForOrg: vi.fn(),
}))
vi.mock('@sssb/kit/adapters/index', () => ({ auth: { requireUser: h.requireUser }, db: {} }))
vi.mock('@sssb/kit/db/tenant-lookup', () => ({ tenantIdForSlug: h.tenantIdForSlug }))
vi.mock('@sssb/kit/db/org-lookup', () => ({ orgIdForSlug: h.orgIdForSlug }))
vi.mock('@sssb/kit/db/webhooks', () => ({ listEndpointsForOrg: h.listEndpointsForOrg, createEndpoint: vi.fn() }))

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

beforeEach(() => {
    for (const fn of Object.values(h)) fn.mockReset()
    h.requireUser.mockResolvedValue(user())
    h.tenantIdForSlug.mockResolvedValue('tenant-northwind')
    h.orgIdForSlug.mockResolvedValue('org-frontline')
    h.listEndpointsForOrg.mockResolvedValue([])
})

describe('GET /api/webhook-endpoints (list)', () => {
    test('returns the active org endpoints', async () => {
        h.listEndpointsForOrg.mockResolvedValue([{ id: 'endpoint-1', url: 'https://hooks.example.test/a' }])

        const response = await GET()

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            endpoints: [{ id: 'endpoint-1', url: 'https://hooks.example.test/a' }],
        })
        expect(h.listEndpointsForOrg).toHaveBeenCalledWith({}, 'tenant-northwind', 'org-frontline')
    })

    // The framework rule: WebhookEndpoint read = sameOrg (any member with standing); only create, update and
    // delete need canManageOrg. So a restricted member reads the list.
    test('a restricted member may still READ (WebhookEndpoint read = sameOrg; only writes are admin-only)', async () => {
        h.requireUser.mockResolvedValue(user({ role: 'restricted', restricted: true }))

        const response = await GET()

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ endpoints: [] })
    })

    test('403 for a person with the role none: no standing in the org, so no org-scoped read', async () => {
        h.requireUser.mockResolvedValue(user({ role: 'none', restricted: true }))

        expect((await GET()).status).toBe(403)
        expect(h.listEndpointsForOrg).not.toHaveBeenCalled()
    })
})
