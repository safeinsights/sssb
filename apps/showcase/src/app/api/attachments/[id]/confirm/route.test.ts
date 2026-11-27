import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AuthUser } from '@sssb/kit/ports/auth'
import { POST } from './route'

// Real authorize (pure abilities) runs — only the adapters and data modules are faked.
const h = vi.hoisted(() => ({
    requireUser: vi.fn(),
    tenantIdForSlug: vi.fn(),
    orgIdForSlug: vi.fn(),
    attachmentForOrg: vi.fn(),
    confirmAttachment: vi.fn(),
    head: vi.fn(),
    remove: vi.fn(),
    recordAuditEvent: vi.fn(),
}))
vi.mock('@sssb/kit/adapters/index', () => ({
    auth: { requireUser: h.requireUser },
    db: {},
    storage: { head: h.head, delete: h.remove },
}))
vi.mock('@sssb/kit/db/tenant-lookup', () => ({ tenantIdForSlug: h.tenantIdForSlug }))
vi.mock('@sssb/kit/db/org-lookup', () => ({ orgIdForSlug: h.orgIdForSlug }))
vi.mock('@sssb/kit/db/audit', () => ({ recordAuditEvent: h.recordAuditEvent }))
vi.mock('@/domain/db/attachments', () => ({
    attachmentForOrg: h.attachmentForOrg,
    confirmAttachment: h.confirmAttachment,
}))

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

function confirm(id = 'a0000000-0000-4000-8000-000000000001'): Promise<Response> {
    return POST(new Request(`http://localhost/api/attachments/${id}/confirm`, { method: 'POST' }), {
        params: Promise.resolve({ id }),
    })
}

beforeEach(() => {
    for (const fn of Object.values(h)) fn.mockReset()
    h.requireUser.mockResolvedValue(user())
    h.tenantIdForSlug.mockResolvedValue('tenant-northwind')
    h.orgIdForSlug.mockResolvedValue('org-frontline')
    h.attachmentForOrg.mockResolvedValue({
        id: 'a0000000-0000-4000-8000-000000000001',
        storageKey: 'attachments/tenant-northwind/uuid/a.txt',
        status: 'pending',
    })
    h.head.mockResolvedValue({ size: 4, contentType: 'text/plain', etag: '"e"', lastModified: new Date(0) })
    h.remove.mockResolvedValue(undefined)
    h.confirmAttachment.mockResolvedValue(1)
})

describe('POST /api/attachments/[id]/confirm', () => {
    test("200 records the object's true size and finalizes the row", async () => {
        const response = await confirm()
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ attachmentId: 'a0000000-0000-4000-8000-000000000001' })
        // Size comes from what the store reports (4), never the client.
        expect(h.confirmAttachment).toHaveBeenCalledWith(
            {},
            'tenant-northwind',
            'org-frontline',
            'a0000000-0000-4000-8000-000000000001',
            4,
        )
        expect(h.recordAuditEvent).toHaveBeenCalledTimes(1)
    })

    test('200-idempotent on a re-confirm of a ready attachment, with NO second audit event', async () => {
        h.confirmAttachment.mockResolvedValue(0)
        const response = await confirm()
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            attachmentId: 'a0000000-0000-4000-8000-000000000001',
            idempotent: true,
        })
        // The audit trail says only what actually happened — nothing did.
        expect(h.recordAuditEvent).not.toHaveBeenCalled()
    })

    test("404 when the id is not one of the active org's attachments (indistinguishable from missing)", async () => {
        h.attachmentForOrg.mockResolvedValue(null)
        expect((await confirm('ghost')).status).toBe(404)
        expect(h.confirmAttachment).not.toHaveBeenCalled()
    })

    test('400 when the upload never landed in storage (no dead download links)', async () => {
        h.head.mockResolvedValue(null)
        expect((await confirm()).status).toBe(400)
        expect(h.confirmAttachment).not.toHaveBeenCalled()
    })

    test('400 and the object deleted when it is over the ceiling: a PUT store that ignored the signed length', async () => {
        h.head.mockResolvedValue({
            size: 5 * 1024 * 1024 + 1,
            contentType: 'text/plain',
            etag: '"e"',
            lastModified: new Date(0),
        })
        const response = await confirm()
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'too-large' })
        expect(h.remove).toHaveBeenCalledWith(['attachments/tenant-northwind/uuid/a.txt'])
        expect(h.confirmAttachment).not.toHaveBeenCalled()
        expect(h.recordAuditEvent).not.toHaveBeenCalled()
    })

    test('an object of exactly the ceiling is confirmed, and nothing is deleted', async () => {
        h.head.mockResolvedValue({
            size: 5 * 1024 * 1024,
            contentType: 'text/plain',
            etag: '"e"',
            lastModified: new Date(0),
        })
        expect((await confirm()).status).toBe(200)
        expect(h.remove).not.toHaveBeenCalled()
    })

    test('403 when a restricted member tries to finalize an upload', async () => {
        h.requireUser.mockResolvedValue(user({ role: 'restricted', restricted: true }))
        expect((await confirm()).status).toBe(403)
        expect(h.confirmAttachment).not.toHaveBeenCalled()
    })

    test('401 when no one is signed in', async () => {
        const { AuthRequiredError } = await import('@sssb/kit/ports/errors')
        h.requireUser.mockRejectedValue(new AuthRequiredError())
        expect((await confirm()).status).toBe(401)
    })
})

describe('a path id that cannot be an attachment', () => {
    test('is a 404, without touching the data module', async () => {
        expect((await confirm('nope')).status).toBe(404)
        expect(h.attachmentForOrg).not.toHaveBeenCalled()
    })
})
