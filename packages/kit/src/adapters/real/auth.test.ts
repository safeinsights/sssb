import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Clerk adapter with Clerk's server SDK replaced: what it asks Clerk for and what it hands back. The adapter has
 * never run against a real Clerk instance (cutover row `auth-dev`), so this pins its side of the contract: Clerk is told
 * to send an invitee to the app's accept page, and the link returned for the invitation mail is Clerk's own invitation
 * URL, which carries the ticket that page reads; every list is read past Clerk's page size; a membership with no role
 * is a guest; and a refused profile update writes nothing.
 */
const h = vi.hoisted(() => ({
    created: [] as Record<string, unknown>[],
    url: 'https://accounts.example.clerk/v1/tickets/accept?ticket=t-1' as string | null,
    // Clerk's lists, served a page at a time as Clerk serves them (`limit`, `offset`; `totalCount` is the whole list).
    orgMembers: [] as unknown[],
    invitations: [] as unknown[],
    myMemberships: [] as unknown[],
    user: null as null | Record<string, unknown>,
    writes: [] as string[],
}))

vi.mock('@clerk/nextjs/server', () => {
    const paged = (rows: unknown[], { limit = 10, offset = 0 }: { limit?: number; offset?: number }) => ({
        data: rows.slice(offset, offset + Math.min(limit, 500)),
        totalCount: rows.length,
    })
    return {
        auth: async () => ({ userId: 'user_inviter' }),
        currentUser: async () => h.user,
        clerkClient: async () => ({
            organizations: {
                getOrganization: async ({ slug }: { slug: string }) => ({ id: `org_${slug}` }),
                createOrganizationInvitation: async (params: Record<string, unknown>) => {
                    h.created.push(params)
                    return { id: 'orginv_1', emailAddress: params['emailAddress'], url: h.url }
                },
                getOrganizationMembershipList: async (params: { limit?: number; offset?: number }) =>
                    paged(h.orgMembers, params),
                getOrganizationInvitationList: async (params: { limit?: number; offset?: number }) =>
                    paged(h.invitations, params),
            },
            users: {
                getOrganizationMembershipList: async (params: { limit?: number; offset?: number }) =>
                    paged(h.myMemberships, params),
                updateUser: async () => {
                    h.writes.push('name')
                },
                updateUserMetadata: async () => {
                    h.writes.push('metadata')
                },
            },
        }),
    }
})
vi.mock('@clerk/nextjs/errors', () => ({ isClerkAPIResponseError: () => false }))

beforeEach(() => {
    h.created.length = 0
    h.url = 'https://accounts.example.clerk/v1/tickets/accept?ticket=t-1'
    h.orgMembers = []
    h.invitations = []
    h.myMemberships = []
    h.user = null
    h.writes = []
})

const member = (n: number, role?: string) => ({
    id: `orgmem_${n}`,
    publicMetadata: role === undefined ? {} : { role },
    publicUserData: { userId: `user_${n}`, firstName: `P${n}`, lastName: null, identifier: `p${n}@example.test` },
})
const myMembership = (n: number, role?: string) => ({
    organization: { id: `org_${n}`, slug: `org-${n}`, name: `Org ${n}` },
    publicMetadata: role === undefined ? {} : { role },
})
const range = (count: number) => Array.from({ length: count }, (_, i) => i)

const INVITE = {
    email: 'invitee@example.test',
    role: 'member' as const,
    orgSlug: 'depot',
    // As the framework builds it behind SssbApp: on the server's own host, which Clerk must never be given.
    acceptPageUrl: 'https://localhost:3000/en/accept-invite',
}

describe('the Clerk adapter, inviting', () => {
    it("sends the invitee to the app's accept page, as a path, and returns Clerk's invitation URL as the link", async () => {
        const { realAuth } = await import('./auth')
        const invite = await realAuth.createInvite(INVITE)
        expect(h.created).toEqual([
            expect.objectContaining({
                organizationId: 'org_depot',
                emailAddress: 'invitee@example.test',
                inviterUserId: 'user_inviter',
                redirectUrl: '/en/accept-invite',
                publicMetadata: { role: 'member' },
            }),
        ])
        expect(invite).toEqual({
            id: 'orginv_1',
            name: null,
            email: 'invitee@example.test',
            role: 'member',
            status: 'invited',
            acceptUrl: 'https://accounts.example.clerk/v1/tickets/accept?ticket=t-1',
        })
    })

    it('returns no link when Clerk gives none, so the framework sends no mail of its own', async () => {
        h.url = null
        const { realAuth } = await import('./auth')
        expect((await realAuth.createInvite(INVITE)).acceptUrl).toBeNull()
    })
})

describe('the Clerk adapter, reading lists longer than one page', () => {
    it("lists every member and every pending invitation of a team, past Clerk's page size", async () => {
        h.orgMembers = range(250).map((n) => member(n, 'member'))
        h.invitations = range(120).map((n) => ({
            id: `orginv_${n}`,
            emailAddress: `i${n}@example.test`,
            publicMetadata: {},
        }))
        const { realAuth } = await import('./auth')
        const members = await realAuth.listMembers('depot')
        expect(members.filter((m) => m.status === 'active').map((m) => m.id)).toEqual(
            range(250).map((n) => `user_${n}`),
        )
        expect(members.filter((m) => m.status === 'invited')).toHaveLength(120)
    })

    it('lists every org a person belongs to, and finds their remembered org past the first page', async () => {
        h.myMemberships = range(130).map((n) => myMembership(n, n === 125 ? 'admin' : 'member'))
        h.user = {
            fullName: 'Pat',
            primaryEmailAddress: { emailAddress: 'pat@example.test' },
            publicMetadata: {},
            unsafeMetadata: { currentOrgSlug: 'org-125' },
        }
        const { realAuth } = await import('./auth')
        expect(await realAuth.listMyOrgs()).toHaveLength(130)
        const user = await realAuth.getCurrentUser()
        expect(user?.orgSlug).toBe('org-125')
        expect(user?.role).toBe('admin')
    })
})

describe('the Clerk adapter, a membership that records no role', () => {
    it('is a guest everywhere: in the session, the switcher and the member list alike', async () => {
        h.orgMembers = [member(1), member(2, 'not-a-role')]
        h.invitations = [{ id: 'orginv_1', emailAddress: 'i@example.test', publicMetadata: {} }]
        h.myMemberships = [myMembership(1)]
        h.user = { fullName: 'Pat', primaryEmailAddress: null, publicMetadata: {}, unsafeMetadata: {} }
        const { realAuth } = await import('./auth')
        expect((await realAuth.getCurrentUser())?.role).toBe('guest')
        expect((await realAuth.listMyOrgs()).map((o) => o.role)).toEqual(['guest'])
        expect((await realAuth.listMembers('depot')).map((m) => m.role)).toEqual(['guest', 'guest', 'guest'])
    })
})

describe('the Clerk adapter, updating a profile', () => {
    it('refuses an unknown locale before writing anything, the name included', async () => {
        const { realAuth } = await import('./auth')
        const update = { name: 'New Name', locale: 'xx' } as unknown as Parameters<typeof realAuth.updateProfile>[0]
        await expect(realAuth.updateProfile(update)).rejects.toThrow('unknown locale')
        expect(h.writes).toEqual([])
    })

    it.each([{ a: 1 }, '', '   ', 'x'.repeat(257)])('refuses the name %j before writing anything', async (name) => {
        const { realAuth } = await import('./auth')
        const update = { name } as unknown as Parameters<typeof realAuth.updateProfile>[0]
        await expect(realAuth.updateProfile(update)).rejects.toThrow('invalid name')
        expect(h.writes).toEqual([])
    })
})
