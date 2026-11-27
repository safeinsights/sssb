import type { AuthUser } from '@sssb/kit/ports/auth'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { DELETE, PATCH } from './route'

// Real authorize runs (WebhookEndpoint update/delete = canManageOrg && sameOrg); only adapters and data are faked.
const h = vi.hoisted(() => ({
    requireUser: vi.fn(),
    tenantIdForSlug: vi.fn(),
    orgIdForSlug: vi.fn(),
    endpointForOrg: vi.fn(),
    setEndpointEnabled: vi.fn(),
    deleteEndpoint: vi.fn(),
    recordAuditEvent: vi.fn(),
}))
vi.mock('@sssb/kit/adapters/index', () => ({ auth: { requireUser: h.requireUser }, db: {} }))
vi.mock('@sssb/kit/db/tenant-lookup', () => ({ tenantIdForSlug: h.tenantIdForSlug }))
vi.mock('@sssb/kit/db/org-lookup', () => ({ orgIdForSlug: h.orgIdForSlug }))
vi.mock('@sssb/kit/db/audit', () => ({ recordAuditEvent: h.recordAuditEvent }))
vi.mock('@sssb/kit/db/webhooks', () => ({
    endpointForOrg: h.endpointForOrg,
    setEndpointEnabled: h.setEndpointEnabled,
    deleteEndpoint: h.deleteEndpoint,
}))

const ID = 'e0000000-0000-4000-8000-000000000001'

function user(overrides: Partial<AuthUser> = {}): AuthUser {
    return {
        id: 'user-sam',
        name: 'Sam Rivera',
        email: 'sam.rivera@example.test',
        role: 'admin',
        locale: 'en',
        tenantSlug: 'northwind',
        orgSlug: 'frontline',
        restricted: false,
        ...overrides,
    }
}

function patch(body: unknown): Promise<Response> {
    return PATCH(
        new Request(`http://localhost/api/webhook-endpoints/${ID}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: ID }) },
    )
}

function del(): Promise<Response> {
    return DELETE(new Request(`http://localhost/api/webhook-endpoints/${ID}`, { method: 'DELETE' }), {
        params: Promise.resolve({ id: ID }),
    })
}

beforeEach(() => {
    for (const fn of Object.values(h)) fn.mockReset()
    h.requireUser.mockResolvedValue(user())
    h.tenantIdForSlug.mockResolvedValue('tenant-northwind')
    h.orgIdForSlug.mockResolvedValue('org-frontline')
    h.endpointForOrg.mockResolvedValue({ id: ID })
})

describe('PATCH and DELETE /api/webhook-endpoints/[id]', () => {
    test('an org admin enables, disables and removes one of the active org endpoints', async () => {
        expect((await patch({ enabled: false })).status).toBe(200)
        expect(h.setEndpointEnabled).toHaveBeenCalledWith({}, 'tenant-northwind', ID, false)
        expect((await del()).status).toBe(200)
        expect(h.deleteEndpoint).toHaveBeenCalledWith({}, 'tenant-northwind', ID)
    })

    test("an org admin gets 404 for an endpoint that is missing or another org's, and nothing is written", async () => {
        h.endpointForOrg.mockResolvedValue(null)

        for (const response of [await patch({ enabled: true }), await del()]) {
            expect(response.status).toBe(404)
            expect(await response.json()).toEqual({ error: 'not found' })
        }
        expect(h.setEndpointEnabled).not.toHaveBeenCalled()
        expect(h.deleteEndpoint).not.toHaveBeenCalled()
    })

    // safeinsights/sssb#137: authorize comes before the lookup, so a person who may not manage endpoints learns
    // nothing about whether the id names one.
    test.each([
        ['a plain member', user({ role: 'member' })],
        ['a restricted member', user({ role: 'restricted', restricted: true })],
        ['a person with no standing (none)', user({ role: 'none', restricted: true })],
    ])('%s gets the same 403 for an existing id as for a missing one, on PATCH and DELETE', async (_, who) => {
        h.requireUser.mockResolvedValue(who)
        const existing = [await patch({ enabled: false }), await del()]
        h.endpointForOrg.mockResolvedValue(null)
        const missing = [await patch({ enabled: false }), await del()]

        for (const [i, response] of existing.entries()) {
            expect(response.status).toBe(403)
            expect([response.status, await response.json()]).toEqual([missing[i]!.status, await missing[i]!.json()])
        }
        expect(h.endpointForOrg).not.toHaveBeenCalled()
        expect(h.setEndpointEnabled).not.toHaveBeenCalled()
        expect(h.deleteEndpoint).not.toHaveBeenCalled()
        expect(h.recordAuditEvent).not.toHaveBeenCalled()
    })
})
