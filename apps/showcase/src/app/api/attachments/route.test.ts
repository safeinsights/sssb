import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AuthUser } from '@sssb/kit/ports/auth'
import { GET, POST } from './route'

// Real authorize (pure abilities) runs — only the adapters and data modules are faked. Low-entropy
// fixture ids/slugs (gitleaks): no hex, no UUIDs.
const h = vi.hoisted(() => ({
    requireUser: vi.fn(),
    tenantIdForSlug: vi.fn(),
    orgIdForSlug: vi.fn(),
    createAttachment: vi.fn(),
    listAttachments: vi.fn(),
    createUploadTarget: vi.fn(),
    getSignedDownloadUrl: vi.fn(),
    recordAuditEvent: vi.fn(),
}))
vi.mock('@sssb/kit/adapters/index', () => ({
    auth: { requireUser: h.requireUser },
    db: {},
    storage: { createUploadTarget: h.createUploadTarget, getSignedDownloadUrl: h.getSignedDownloadUrl },
}))
vi.mock('@sssb/kit/db/tenant-lookup', () => ({ tenantIdForSlug: h.tenantIdForSlug }))
vi.mock('@sssb/kit/db/org-lookup', () => ({ orgIdForSlug: h.orgIdForSlug }))
vi.mock('@sssb/kit/db/audit', () => ({ recordAuditEvent: h.recordAuditEvent }))
vi.mock('@/domain/db/attachments', () => ({ createAttachment: h.createAttachment, listAttachments: h.listAttachments }))

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

function post(body: unknown): Promise<Response> {
    return POST(
        new Request('http://localhost/api/attachments', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
    )
}

beforeEach(() => {
    for (const fn of Object.values(h)) fn.mockReset()
    h.requireUser.mockResolvedValue(user())
    h.tenantIdForSlug.mockResolvedValue('tenant-northwind')
    h.orgIdForSlug.mockResolvedValue('org-frontline')
    h.createAttachment.mockResolvedValue({ id: 'art-1' })
    h.createUploadTarget.mockResolvedValue({ url: '/api/storage-upload', fields: { key: 'k' } })
})

describe('POST /api/attachments (mint)', () => {
    test('201 mints a pending row with a SERVER-BUILT key and returns the upload target', async () => {
        const response = await post({ filename: 'report.csv', contentType: 'text/csv', sizeBytes: 12 })

        expect(response.status).toBe(201)
        expect(await response.json()).toEqual({
            attachmentId: 'art-1',
            upload: { url: '/api/storage-upload', fields: { key: 'k' } },
        })

        // The key the browser can never choose: attachments/<tenantId>/<uuid>/<sanitized-filename>.
        const passedKey = h.createAttachment.mock.calls[0]![1].storageKey as string
        expect(passedKey).toMatch(/^attachments\/tenant-northwind\/[0-9a-f-]{36}\/report\.csv$/)
        expect(h.createAttachment).toHaveBeenCalledWith(
            {},
            expect.objectContaining({
                tenantId: 'tenant-northwind',
                orgId: 'org-frontline',
                kind: 'attachment',
                filename: 'report.csv',
                contentType: 'text/csv',
                uploadedByUserId: 'user-ada',
            }),
        )
        // The upload target is minted for that exact key with the size ceiling.
        expect(h.createUploadTarget).toHaveBeenCalledWith(passedKey, {
            contentType: 'text/csv',
            maxBytes: 5 * 1024 * 1024,
            sizeBytes: 12,
        })
    })

    test('defaults content-type to octet-stream and kind to attachment', async () => {
        await post({ filename: 'blob', sizeBytes: 1 })
        expect(h.createAttachment).toHaveBeenCalledWith(
            {},
            expect.objectContaining({
                contentType: 'application/octet-stream',
                kind: 'attachment',
            }),
        )
    })

    test('400 on a missing filename, an unknown kind, or an over-ceiling declared size', async () => {
        expect((await post({ contentType: 'text/csv' })).status).toBe(400)
        expect((await post({ filename: 'x', kind: 'results' })).status).toBe(400)
        expect((await post({ filename: 'x', sizeBytes: 6 * 1024 * 1024 })).status).toBe(400)
        expect(h.createAttachment).not.toHaveBeenCalled()
    })

    test('400 invalid-size unless sizeBytes is a whole number of bytes: a PUT target signs exactly it', async () => {
        for (const sizeBytes of [undefined, '12', -1, 1.5, null]) {
            const response = await post({ filename: 'x', ...(sizeBytes === undefined ? {} : { sizeBytes }) })
            expect(response.status, String(sizeBytes)).toBe(400)
            expect(await response.json()).toEqual({ error: 'invalid-size' })
        }
        expect(h.createUploadTarget).not.toHaveBeenCalled()
    })

    test('passes a size of exactly the ceiling, and refuses one byte over', async () => {
        expect((await post({ filename: 'x', sizeBytes: 5 * 1024 * 1024 })).status).toBe(201)
        expect((await post({ filename: 'x', sizeBytes: 5 * 1024 * 1024 + 1 })).status).toBe(400)
    })

    test('returns a PUT target as the store minted it', async () => {
        const target = { method: 'PUT', url: 'https://store/k?sig=1', headers: { 'Content-Type': 'text/csv' } }
        h.createUploadTarget.mockResolvedValue(target)
        const response = await post({ filename: 'report.csv', contentType: 'text/csv', sizeBytes: 12 })
        expect(await response.json()).toEqual({ attachmentId: 'art-1', upload: target })
    })

    test('writes no pending row when the store refuses to mint the target (no orphan row)', async () => {
        h.createUploadTarget.mockRejectedValue(new Error('storage createUploadTarget: refused'))
        await expect(post({ filename: 'x', sizeBytes: 1 })).rejects.toThrow(/refused/)
        expect(h.createAttachment).not.toHaveBeenCalled()
        expect(h.recordAuditEvent).not.toHaveBeenCalled()
    })

    test('403 when a restricted member tries to upload', async () => {
        h.requireUser.mockResolvedValue(user({ role: 'restricted', restricted: true }))
        const response = await post({ filename: 'report.csv', contentType: 'text/csv', sizeBytes: 12 })
        expect(response.status).toBe(403)
        expect(h.createAttachment).not.toHaveBeenCalled()
    })

    test('404 when the tenant or org is unknown', async () => {
        h.tenantIdForSlug.mockResolvedValueOnce(null)
        expect((await post({ filename: 'x', sizeBytes: 1 })).status).toBe(404)
        h.orgIdForSlug.mockResolvedValueOnce(null)
        expect((await post({ filename: 'x', sizeBytes: 1 })).status).toBe(404)
        expect(h.createAttachment).not.toHaveBeenCalled()
    })
})

describe('GET /api/attachments (list)', () => {
    test('returns ready attachments with a signed download URL, stripping the storage key', async () => {
        h.listAttachments.mockResolvedValue([
            {
                id: 'art-1',
                kind: 'attachment',
                filename: 'report.csv',
                contentType: 'text/csv',
                sizeBytes: 12,
                createdAt: '2026-07-22T00:00:00.000Z',
                storageKey: 'attachments/tenant-northwind/uuid/report.csv',
            },
        ])
        h.getSignedDownloadUrl.mockResolvedValue('/api/storage/attachments/tenant-northwind/uuid/report.csv')

        const response = await GET()
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            attachments: [
                {
                    id: 'art-1',
                    kind: 'attachment',
                    filename: 'report.csv',
                    contentType: 'text/csv',
                    sizeBytes: 12,
                    createdAt: '2026-07-22T00:00:00.000Z',
                    downloadUrl: '/api/storage/attachments/tenant-northwind/uuid/report.csv',
                },
            ],
        })
        expect(h.getSignedDownloadUrl).toHaveBeenCalledWith('attachments/tenant-northwind/uuid/report.csv')
    })

    test('a restricted member may still READ the list (Attachment read = sameOrg, not gated on restricted)', async () => {
        h.requireUser.mockResolvedValue(user({ role: 'restricted', restricted: true }))
        h.listAttachments.mockResolvedValue([])

        const response = await GET()

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ attachments: [] })
    })

    test('403 for a person with the role none: no standing in the org, so no org-scoped read', async () => {
        h.requireUser.mockResolvedValue(user({ role: 'none', restricted: true }))

        expect((await GET()).status).toBe(403)
        expect(h.listAttachments).not.toHaveBeenCalled()
    })

    test('401 when no one is signed in', async () => {
        const { AuthRequiredError } = await import('@sssb/kit/ports/errors')
        h.requireUser.mockRejectedValue(new AuthRequiredError())
        expect((await GET()).status).toBe(401)
    })
})

describe('POST /api/attachments: a malformed body is a 400, never a 500', () => {
    test('a body that does not parse, and fields of the wrong type', async () => {
        expect(
            (await POST(new Request('http://localhost/api/attachments', { method: 'POST', body: '{' }))).status,
        ).toBe(400)
        expect((await post({ filename: 5 })).status).toBe(400)
        expect((await post({ filename: 'a.txt', contentType: 7 })).status).toBe(400)
        expect((await post({ filename: 'a.txt', kind: ['attachment'] })).status).toBe(400)
        expect(h.createAttachment).not.toHaveBeenCalled()
    })
})
