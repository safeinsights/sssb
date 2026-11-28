import type { AuthUser } from '@sssb/kit/ports/auth'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { GET } from './route'

const h = vi.hoisted(() => ({ requireUser: vi.fn(), tenantIdForSlug: vi.fn(), orgIdForSlug: vi.fn(), rows: vi.fn() }))
vi.mock('@sssb/kit/adapters/index', () => ({ auth: { requireUser: h.requireUser }, db: {} }))
vi.mock('@sssb/kit/db/tenant-lookup', () => ({ tenantIdForSlug: h.tenantIdForSlug }))
vi.mock('@sssb/kit/db/org-lookup', () => ({ orgIdForSlug: h.orgIdForSlug }))
vi.mock('@sssb/kit/db/notifications', () => ({ readPrefRows: h.rows, setPref: vi.fn() }))

const person = (over: Partial<AuthUser>): AuthUser => ({
    id: 'user-ada',
    name: 'Dana Okoye',
    email: 'dana.okoye@example.test',
    role: 'member',
    locale: 'en',
    tenantSlug: 'northwind',
    orgSlug: 'frontline',
    restricted: false,
    ...over,
})

beforeEach(() => {
    for (const fn of Object.values(h)) fn.mockReset()
    h.tenantIdForSlug.mockResolvedValue('tenant-northwind')
    h.orgIdForSlug.mockResolvedValue('org-frontline')
    h.rows.mockResolvedValue([])
})

describe('GET /api/notification-prefs', () => {
    // The read authorizes a self-only NotificationPref subject (safeinsights/sssb#103), which holds for anyone reading
    // their own preferences, a person with no standing (the role `none`) included.
    test.each([
        ['a member', person({})],
        ['a restricted member', person({ role: 'restricted', restricted: true })],
        ['a person with no standing (none)', person({ role: 'none', restricted: true })],
    ])('%s reads their own preferences, by their own id', async (_, user) => {
        h.requireUser.mockResolvedValue(user)

        const response = await GET()

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ prefs: [] })
        expect(h.rows).toHaveBeenCalledWith({}, 'tenant-northwind', 'org-frontline', 'user-ada')
    })
})
