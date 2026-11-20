import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AuthUser } from '@sssb/kit/ports/auth'
import { GET, POST } from './route'

// Real authorize (pure abilities) runs — only the adapters and data modules are faked. Low-entropy
// fixture ids/slugs (gitleaks): no hex, no UUIDs.
const h = vi.hoisted(() => ({
    requireUser: vi.fn(),
    tenantIdForSlug: vi.fn(),
    orgIdForSlug: vi.fn(),
    listJobs: vi.fn(),
    getSignedDownloadUrl: vi.fn(),
    submitJob: vi.fn(),
    recordAuditEvent: vi.fn(),
}))
vi.mock('@sssb/kit/adapters/index', () => ({
    auth: { requireUser: h.requireUser },
    db: {},
    jobs: {},
    storage: { getSignedDownloadUrl: h.getSignedDownloadUrl },
}))
vi.mock('@sssb/kit/db/tenant-lookup', () => ({ tenantIdForSlug: h.tenantIdForSlug }))
vi.mock('@sssb/kit/db/org-lookup', () => ({ orgIdForSlug: h.orgIdForSlug }))
vi.mock('@sssb/kit/db/jobs', () => ({ listJobs: h.listJobs, submitJob: h.submitJob }))
vi.mock('@sssb/kit/db/audit', () => ({ recordAuditEvent: h.recordAuditEvent }))

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
    h.listJobs.mockResolvedValue([])
    h.submitJob.mockResolvedValue({ id: 'job-new' })
})

describe('GET /api/jobs (list)', () => {
    test('returns the active org jobs, with a download URL only for a completed job that has a result', async () => {
        h.listJobs.mockResolvedValue([
            { id: 'job-1', status: 'completed', resultKey: 'results/job-1' },
            { id: 'job-2', status: 'running', resultKey: null },
        ])
        h.getSignedDownloadUrl.mockResolvedValue('/api/storage/results/job-1')

        const response = await GET()

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            jobs: [
                {
                    id: 'job-1',
                    status: 'completed',
                    resultKey: 'results/job-1',
                    downloadUrl: '/api/storage/results/job-1',
                },
                { id: 'job-2', status: 'running', resultKey: null, downloadUrl: null },
            ],
        })
        expect(h.listJobs).toHaveBeenCalledWith({}, 'tenant-northwind', 'org-frontline', { limit: 10 })
    })

    test('a restricted member may still READ (Job read = sameOrg; only create is gated on restricted)', async () => {
        h.requireUser.mockResolvedValue(user({ role: 'restricted', restricted: true }))

        const response = await GET()

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ jobs: [] })
    })

    test('403 for a person with the role none: no standing in the org, so no org-scoped read', async () => {
        h.requireUser.mockResolvedValue(user({ role: 'none', restricted: true }))

        expect((await GET()).status).toBe(403)
        expect(h.listJobs).not.toHaveBeenCalled()
    })
})

describe('POST /api/jobs (submit)', () => {
    const KIND = 'export-tickets'
    const submit = (kind: string) =>
        POST(new Request('http://h/api/jobs', { method: 'POST', body: JSON.stringify({ kind }) }))

    test('records who submitted the job, so its end can reach them when the team has no admin', async () => {
        const response = await submit(KIND)

        expect(response.status).toBe(201)
        expect(h.submitJob).toHaveBeenCalledWith(
            {},
            {},
            {
                tenantId: 'tenant-northwind',
                orgId: 'org-frontline',
                kind: KIND,
                payload: {},
                requestedBy: 'user-ada',
            },
        )
    })
})
