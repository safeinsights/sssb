import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { makeTestTmpDir } from '../testing/tmp-dir'

// The invite flow against the fake adapters, unmocked but for the one method a case replaces: the link the invitation
// mail carries is the auth adapter's to give, because only the adapter knows what its accept page reads (the fake's
// `?invite=<id>`, Clerk's `__clerk_ticket`). Same setup as ./demo-presets.test.ts: a throwaway data directory, a
// mocked cookie jar, the registry replaced by the fakes it would build, next-intl's translator stubbed.
const tmp = makeTestTmpDir('app-invite-')
beforeAll(() => {
    process.env['APP_DATA_DIR'] = tmp
})
afterAll(() => {
    delete process.env['APP_DATA_DIR']
})
afterEach(() => {
    vi.restoreAllMocks()
})

const cookieStore = new Map<string, { value: string }>()
vi.mock('next/headers', () => ({
    cookies: async () => ({
        get: (name: string) => cookieStore.get(name),
        set: (name: string, value: string) => cookieStore.set(name, { value }),
        delete: (name: string) => cookieStore.delete(name),
    }),
}))
vi.mock('../adapters/index', async () => ({
    isSimulated: true,
    auth: (await import('../adapters/fake/auth')).fakeAuth,
    db: (await import('../adapters/fake/db')).fakeDb,
    email: (await import('../adapters/fake/email')).fakeEmail,
    analytics: (await import('../adapters/fake/analytics')).fakeAnalytics,
}))
vi.mock('next-intl/server', () => ({
    getTranslations: async () => (key: string) => key,
}))

async function inviteInput(email: string) {
    const { fakeDb } = await import('../adapters/fake/db')
    const { fakeAuth } = await import('../adapters/fake/auth')
    await fakeDb.ready()
    const tenant = await fakeDb
        .getDb()
        .selectFrom('tenants')
        .select('id')
        .where('slug', '=', 'harbor')
        .executeTakeFirstOrThrow()
    const org = await fakeDb
        .getDb()
        .selectFrom('organizations')
        .select(['id', 'name'])
        .where('slug', '=', 'depot')
        .executeTakeFirstOrThrow()
    return {
        inviter: { id: 'inviter-1', name: 'Ines Inviter', locale: 'en' as const },
        tenantSlug: 'harbor',
        tenantId: tenant.id,
        orgId: org.id,
        orgSlug: 'depot',
        orgName: org.name,
        email,
        role: 'member' as const,
        members: await fakeAuth.listMembers('depot'),
        baseUrl: 'http://localhost:3000/api/org/invite',
    }
}

const mailTo = async (to: string) =>
    (await import('../adapters/fake/email')).listCaughtEmails().filter((m) => m.to === to)

describe('sendOrgInvite', () => {
    test("mails the link the auth adapter returns, having told it where the app's accept page is", async () => {
        const { fakeAuth } = await import('../adapters/fake/auth')
        const { sendOrgInvite } = await import('./invite')
        const spy = vi.spyOn(fakeAuth, 'createInvite').mockResolvedValue({
            id: 'inv-1',
            name: null,
            email: 'ticket.holder@example.test',
            role: 'member',
            status: 'invited',
            acceptUrl: 'https://accounts.idp.example/accept?ticket=abc',
        })
        await sendOrgInvite(await inviteInput('ticket.holder@example.test'))
        expect(spy).toHaveBeenCalledWith(
            expect.objectContaining({ acceptPageUrl: 'http://localhost:3000/en/accept-invite' }),
        )
        const mail = await mailTo('ticket.holder@example.test')
        expect(mail).toHaveLength(1)
        expect(mail[0]!.html).toContain('https://accounts.idp.example/accept?ticket=abc')
        expect(mail[0]!.html).not.toContain('?invite=')
    })

    test('sends no mail of its own when the adapter gives no link (the provider delivers the invitation)', async () => {
        const { fakeAuth } = await import('../adapters/fake/auth')
        const { sendOrgInvite } = await import('./invite')
        vi.spyOn(fakeAuth, 'createInvite').mockResolvedValue({
            id: 'inv-2',
            name: null,
            email: 'provider.mailed@example.test',
            role: 'member',
            status: 'invited',
            acceptUrl: null,
        })
        await sendOrgInvite(await inviteInput('provider.mailed@example.test'))
        expect(await mailTo('provider.mailed@example.test')).toEqual([])
    })

    test("never hands the link back to the inviter: it is the invitee's credential", async () => {
        const { fakeAuth } = await import('../adapters/fake/auth')
        const { sendOrgInvite } = await import('./invite')
        vi.spyOn(fakeAuth, 'createInvite').mockResolvedValue({
            id: 'inv-3',
            name: null,
            email: 'kept.secret@example.test',
            role: 'member',
            status: 'invited',
            acceptUrl: 'https://accounts.idp.example/accept?ticket=secret',
        })
        const membership = await sendOrgInvite(await inviteInput('kept.secret@example.test'))
        expect(membership).toEqual({
            id: 'inv-3',
            name: null,
            email: 'kept.secret@example.test',
            role: 'member',
            status: 'invited',
        })
    })

    test("the fake's link is its own accept page with the invite's id, and the page resolves it", async () => {
        const { sendOrgInvite } = await import('./invite')
        const { findInvite } = await import('../adapters/fake/auth')
        const membership = await sendOrgInvite(await inviteInput('fake.invitee@example.test'))
        const mail = await mailTo('fake.invitee@example.test')
        expect(mail[0]!.html).toContain(`http://localhost:3000/en/accept-invite?invite=${membership.id}`)
        expect(findInvite(membership.id)).toMatchObject({ email: 'fake.invitee@example.test', orgSlug: 'depot' })
    })
})
