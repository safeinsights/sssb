import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import type { AuthPort, MemberStanding, Membership } from '../ports/auth'
import { makeTestTmpDir } from '../testing/tmp-dir'

// The deferred email/sms channels are out of scope (notify.test.ts says why): what is asserted is who got the in-app row.
vi.mock('./defer', () => ({ deferAfterResponse: async () => undefined }))

const tmp = makeTestTmpDir('app-notify-requester-')
beforeAll(() => {
    process.env['APP_DATA_DIR'] = tmp
})
afterAll(() => {
    delete process.env['APP_DATA_DIR']
})

/**
 * Who hears a job's end: the org's active admins, as always; and when the org has no admin to tell (a fixed org source
 * lists no members at all), the person who submitted it, while the auth port still gives them standing in the org.
 */
const ADMIN: Membership = { id: 'admin-1', name: 'Admin', email: 'admin@example.test', role: 'admin', status: 'active' }
const STANDING: MemberStanding = { role: 'none', restricted: true, name: 'Rae Quest', email: 'rae@example.test' }

async function world() {
    const { fakeDb } = await import('../adapters/fake/db')
    await fakeDb.ready()
    const db = fakeDb.getDb()
    const tenant = await db.selectFrom('tenants').select('id').where('slug', '=', 'harbor').executeTakeFirstOrThrow()
    const org = await db
        .selectFrom('organizations')
        .select('id')
        .where('tenant_id', '=', tenant.id)
        .where('slug', '=', 'depot')
        .executeTakeFirstOrThrow()
    return { fakeDb, tenantId: tenant.id, orgId: org.id }
}

async function recipients(jobId: string): Promise<string[]> {
    const { fakeDb } = await world()
    const rows = await fakeDb
        .getDb()
        .selectFrom('notifications')
        .select(['recipient_user_id', 'payload'])
        .where('kind', '=', 'job.completed')
        .execute()
    return rows.filter((r) => (r.payload as { jobId?: string }).jobId === jobId).map((r) => r.recipient_user_id)
}

async function endJob(auth: Pick<AuthPort, 'listMembers' | 'getMember'>, requestedBy: string | null) {
    const { fakeDb, tenantId, orgId } = await world()
    const { recordWebhookCompletion, submitJob } = await import('../db/jobs')
    const { notifyJobTerminal } = await import('./notify')
    const deps = { db: fakeDb, email: { send: async () => undefined }, sms: async () => undefined }
    const { id } = await submitJob(
        fakeDb,
        { start: async () => undefined },
        { tenantId, orgId, kind: 'export-dockets', payload: {}, requestedBy },
    )
    await recordWebhookCompletion(fakeDb, { tenantId, jobId: id, status: 'completed' })
    await notifyJobTerminal(deps, auth as AuthPort, { tenantId, jobId: id, status: 'completed' })
    return recipients(id)
}

function auth(members: Membership[], standing: MemberStanding | null) {
    return { listMembers: vi.fn(async () => members), getMember: vi.fn(async () => standing) }
}

describe("a job's end", () => {
    test('reaches the org admins, and only them, when it has any: the requester is not added', async () => {
        const port = auth([ADMIN], STANDING)
        expect(await endJob(port, 'user-rae')).toEqual(['admin-1'])
        expect(port.getMember).not.toHaveBeenCalled()
    })

    test('reaches the person who submitted it when the org has no admin to tell', async () => {
        const port = auth([], STANDING)
        expect(await endJob(port, 'user-rae')).toEqual(['user-rae'])
        expect(port.getMember).toHaveBeenCalledWith('depot', 'user-rae')
    })

    test('an admin who is only invited, or a member who is not an admin, is no admin to tell', async () => {
        const invited: Membership = { ...ADMIN, status: 'invited' }
        const member: Membership = { ...ADMIN, id: 'member-1', role: 'member' }
        expect(await endJob(auth([invited, member], STANDING), 'user-rae')).toEqual(['user-rae'])
    })

    test('reaches no one when the submitter has no standing left in the org', async () => {
        expect(await endJob(auth([], null), 'user-rae')).toEqual([])
    })

    test('reaches no one, and asks after no one, when no person submitted it', async () => {
        const port = auth([], STANDING)
        expect(await endJob(port, null)).toEqual([])
        expect(port.getMember).not.toHaveBeenCalled()
    })
})
