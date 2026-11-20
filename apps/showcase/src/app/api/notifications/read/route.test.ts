import { beforeEach, describe, expect, test, vi } from 'vitest'
import { POST } from './route'

const h = vi.hoisted(() => ({ requireUser: vi.fn(), tenantIdForSlug: vi.fn(), markRead: vi.fn() }))
vi.mock('@sssb/kit/adapters/index', () => ({ auth: { requireUser: h.requireUser }, db: {} }))
vi.mock('@sssb/kit/db/tenant-lookup', () => ({ tenantIdForSlug: h.tenantIdForSlug }))
vi.mock('@sssb/kit/db/org-lookup', () => ({ orgIdForSlug: vi.fn() }))
vi.mock('@sssb/kit/db/notifications', () => ({ markNotificationsRead: h.markRead }))

const ID = 'f0000000-0000-4000-8000-000000000001'

function post(body?: string): Promise<Response> {
    return POST(
        new Request('http://localhost/api/notifications/read', {
            method: 'POST',
            ...(body === undefined ? {} : { body }),
        }),
    )
}

beforeEach(() => {
    for (const fn of Object.values(h)) fn.mockReset()
    h.requireUser.mockResolvedValue({
        id: 'user-ada',
        name: 'Dana Okoye',
        email: 'dana.okoye@example.test',
        role: 'member',
        locale: 'en',
        tenantSlug: 'northwind',
        orgSlug: 'frontline',
        restricted: false,
    })
    h.tenantIdForSlug.mockResolvedValue('tenant-northwind')
    h.markRead.mockResolvedValue(1)
})

describe('POST /api/notifications/read', () => {
    test('no body, or a body without ids, marks everything read', async () => {
        expect((await post()).status).toBe(200)
        expect((await post('{}')).status).toBe(200)
        expect(h.markRead.mock.calls.map((call) => call[4])).toEqual([undefined, undefined])
    })

    test('a list of ids marks those', async () => {
        expect((await post(JSON.stringify({ ids: [ID] }))).status).toBe(200)
        expect(h.markRead.mock.calls[0]?.[4]).toEqual([ID])
    })

    test.each([['"' + ID + '"'], ['{"x":1}'], ['5'], ['null'], ['["nope"]']])(
        'ids that is %s is a 400, never a silent mark-all',
        async (ids) => {
            expect((await post(`{"ids":${ids}}`)).status).toBe(400)
            expect(h.markRead).not.toHaveBeenCalled()
        },
    )
})
