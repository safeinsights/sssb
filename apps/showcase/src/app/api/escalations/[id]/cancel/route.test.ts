import { beforeEach, describe, expect, test, vi } from 'vitest'
import { InvalidTransitionError } from '@sssb/kit/core/state-machine'
import type { AuthUser } from '@sssb/kit/ports/auth'
import { POST } from './route'

// Real authorize runs; only adapters + data modules are faked. Marisol acts in frontline (requester).
const h = vi.hoisted(() => ({
    requireUser: vi.fn(),
    tenantIdForSlug: vi.fn(),
    orgIdForSlug: vi.fn(),
    escalationForActiveOrg: vi.fn(),
    transitionEscalation: vi.fn(),
    recordAuditEvent: vi.fn(),
    enqueueWebhookEvent: vi.fn(),
}))
vi.mock('@sssb/kit/adapters/index', () => ({ auth: { requireUser: h.requireUser }, db: {} }))
vi.mock('@sssb/kit/db/tenant-lookup', () => ({ tenantIdForSlug: h.tenantIdForSlug }))
vi.mock('@sssb/kit/db/org-lookup', () => ({ orgIdForSlug: h.orgIdForSlug }))
vi.mock('@sssb/kit/db/audit', () => ({ recordAuditEvent: h.recordAuditEvent }))
vi.mock('@/domain/db/escalations', () => ({
    escalationForActiveOrg: h.escalationForActiveOrg,
    transitionEscalation: h.transitionEscalation,
}))
vi.mock('@sssb/kit/db/webhooks', () => ({ enqueueWebhookEvent: h.enqueueWebhookEvent }))

function user(overrides: Partial<AuthUser> = {}): AuthUser {
    return {
        id: 'user-marisol',
        name: 'Marisol Vega',
        email: 'marisol.vega@example.test',
        role: 'member',
        locale: 'es',
        tenantSlug: 'northwind',
        orgSlug: 'frontline',
        restricted: false,
        ...overrides,
    }
}

const ORG_IDS: Record<string, string> = { frontline: 'org-frontline', platform: 'org-platform' }
// An escalation frontline -> platform: the active org (frontline) is the requester side and may withdraw.
const REQUEST = {
    id: 'c0000000-0000-4000-8000-000000000001',
    status: 'open',
    requesterOrgId: 'org-frontline',
    responderOrgId: 'org-platform',
}

function post(id = 'c0000000-0000-4000-8000-000000000001'): Promise<Response> {
    return POST(new Request(`http://localhost/api/escalations/${id}/cancel`, { method: 'POST' }), {
        params: Promise.resolve({ id }),
    })
}

beforeEach(() => {
    for (const fn of Object.values(h)) fn.mockReset()
    h.requireUser.mockResolvedValue(user())
    h.tenantIdForSlug.mockResolvedValue('tenant-northwind')
    h.orgIdForSlug.mockImplementation(async (_db: unknown, _tenantId: string, slug: string) => ORG_IDS[slug] ?? null)
    h.escalationForActiveOrg.mockResolvedValue(REQUEST)
    h.transitionEscalation.mockResolvedValue(undefined)
})

describe('POST /api/escalations/[id]/cancel', () => {
    test('200 withdraws the escalation as a member of the requester side (soft cancel)', async () => {
        const response = await post()

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ id: 'c0000000-0000-4000-8000-000000000001', status: 'cancelled' })
        expect(h.transitionEscalation).toHaveBeenCalledWith(
            {},
            'tenant-northwind',
            'c0000000-0000-4000-8000-000000000001',
            'cancelled',
            {
                byUserId: 'user-marisol',
            },
        )
    })

    // safeinsights/sssb#137: a person who may not withdraw learns nothing about whether the id exists.
    test.each([
        ['a restricted member', user({ role: 'restricted', restricted: true })],
        ['a person with no standing (none)', user({ role: 'none', restricted: true })],
        ['a member of the responder side', user({ orgSlug: 'platform' })],
    ])('%s gets the same 404 for an existing id as for a missing one', async (_, who) => {
        h.requireUser.mockResolvedValue(who)
        const existing = await post()
        h.escalationForActiveOrg.mockResolvedValue(null)
        const missing = await post()

        expect(existing.status).toBe(404)
        expect([existing.status, await existing.json()]).toEqual([missing.status, await missing.json()])
        expect(h.transitionEscalation).not.toHaveBeenCalled()
        expect(h.recordAuditEvent).not.toHaveBeenCalled()
    })

    test("404 when the active org is not a party to the escalation (or it's absent)", async () => {
        h.escalationForActiveOrg.mockResolvedValue(null)

        const response = await post()

        expect(response.status).toBe(404)
        expect(h.transitionEscalation).not.toHaveBeenCalled()
    })

    test('409 with from/to when the escalation was already decided', async () => {
        h.transitionEscalation.mockRejectedValue(new InvalidTransitionError('accepted', 'cancelled'))

        const response = await post()

        expect(response.status).toBe(409)
        expect(await response.json()).toEqual({ error: 'invalid-transition', from: 'accepted', to: 'cancelled' })
    })
})

describe('a path id that cannot be an escalation', () => {
    test('is a 404, without touching the data module', async () => {
        expect((await post('nope')).status).toBe(404)
        expect(h.escalationForActiveOrg).not.toHaveBeenCalled()
    })
})
