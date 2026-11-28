import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Clerk adapter with Clerk's server SDK replaced: what it asks Clerk for and what it hands back. The adapter has
 * never run against a real Clerk instance (cutover row `auth-dev`), so this pins its side of the contract: Clerk is told
 * to send an invitee to the app's accept page, and the link returned for the invitation mail is Clerk's own invitation
 * URL, which carries the ticket that page reads; every list is read past Clerk's page size; a membership with no role
 * is a guest; a refused profile update writes nothing; and a server render reads the person from Clerk once
 * (safeinsights/sssb#200), with React's per-render `cache` simulated here, since outside a server render it shares nothing.
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
    // What the mocked Clerk serves at most per page, whatever `limit` asks, and a totalCount that lies when set.
    serverPageCap: 500,
    reportedTotal: null as number | null,
    // A broken server that answers every page with a row and never reaches its count.
    endless: false,
    // Every Backend API call, by name (`auth()` is local, and counted apart), and a read that fails once when set.
    calls: [] as string[],
    authCalls: 0,
    clientCalls: 0,
    failNextUserRead: false,
}))

/**
 * React's `cache`, as a server render gives it: inside `render.scope` every cached function answers once per scope
 * (the adapter caches only functions of no arguments); with no scope, as in a route handler, it calls through.
 */
const render = vi.hoisted(() => ({ scope: null as Map<unknown, unknown> | null }))
vi.mock('react', async (importOriginal) => ({
    ...(await importOriginal<typeof import('react')>()),
    cache:
        <T>(fn: () => T) =>
        (): T => {
            const scope = render.scope
            if (!scope) return fn()
            if (!scope.has(fn)) scope.set(fn, fn())
            return scope.get(fn) as T
        },
}))

vi.mock('@clerk/nextjs/server', () => {
    const paged = (rows: unknown[], { limit = 10, offset = 0 }: { limit?: number; offset?: number }) => ({
        data: h.endless ? rows.slice(0, 1) : rows.slice(offset, offset + Math.min(limit, h.serverPageCap)),
        totalCount: h.reportedTotal ?? rows.length,
    })
    return {
        auth: async () => {
            h.authCalls += 1
            return { userId: 'user_inviter', sessionId: 'sess_1' }
        },
        currentUser: async () => {
            h.calls.push('currentUser')
            if (h.failNextUserRead) {
                h.failNextUserRead = false
                throw new Error('Clerk is down')
            }
            return h.user
        },
        clerkClient: async () => {
            h.clientCalls += 1
            return {
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
                    getOrganizationMembershipList: async (params: { limit?: number; offset?: number }) => {
                        h.calls.push('users.getOrganizationMembershipList')
                        return paged(h.myMemberships, params)
                    },
                    updateUser: async (_userId: string, update: { firstName: string; lastName: string }) => {
                        h.writes.push('name')
                        if (h.user) h.user = { ...h.user, fullName: `${update.firstName} ${update.lastName}`.trim() }
                    },
                    updateUserMetadata: async (_userId: string, update: { unsafeMetadata?: unknown }) => {
                        h.writes.push('metadata')
                        if (h.user && update.unsafeMetadata)
                            h.user = { ...h.user, unsafeMetadata: update.unsafeMetadata }
                    },
                },
            }
        },
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
    h.serverPageCap = 500
    h.reportedTotal = null
    h.endless = false
    h.calls = []
    h.authCalls = 0
    h.clientCalls = 0
    h.failNextUserRead = false
    render.scope = null
    // What the adapter requires before it reads a session outside a production build (./clerk-keyless.ts).
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_1')
    vi.stubEnv('NEXT_PUBLIC_CLERK_KEYLESS_DISABLED', '1')
})
afterEach(() => {
    vi.unstubAllEnvs()
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

describe('the Clerk adapter, a server that serves fewer rows per page than asked', () => {
    it('still reads to the count: 50 per page of 120 lists all 120', async () => {
        h.serverPageCap = 50
        h.orgMembers = range(120).map((n) => member(n, 'member'))
        const { realAuth } = await import('./auth')
        expect(await realAuth.listMembers('depot')).toHaveLength(120)
    })

    it('stops on an empty page when the count is more than there is', async () => {
        h.orgMembers = range(3).map((n) => member(n, 'member'))
        h.reportedTotal = 10
        const { realAuth } = await import('./auth')
        expect(await realAuth.listMembers('depot')).toHaveLength(3)
    })

    it('throws rather than loop without end on a list that never reaches its count', async () => {
        h.orgMembers = [member(1, 'member')]
        h.reportedTotal = Number.MAX_SAFE_INTEGER
        h.endless = true
        const { realAuth } = await import('./auth')
        await expect(realAuth.listMembers('depot')).rejects.toThrow(/ran past 1000 pages/)
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

const PAT = {
    fullName: 'Pat',
    primaryEmailAddress: { emailAddress: 'pat@example.test' },
    publicMetadata: {},
    unsafeMetadata: { currentOrgSlug: 'org-1' },
}

describe('the Clerk adapter, reading the person once per server render', () => {
    beforeEach(() => {
        h.user = PAT
        h.myMemberships = [myMembership(1, 'admin'), myMembership(2, 'member')]
    })

    it('makes two Backend API calls however many layouts, pages and components ask', async () => {
        const { clerkIdentitySource, realAuth } = await import('./auth')
        render.scope = new Map()
        // A layout and a page at once, then a component, then a route-style guard: all in one render.
        await Promise.all([realAuth.getCurrentUser(), realAuth.listMyOrgs(), clerkIdentitySource.current()])
        await realAuth.requireUser()
        await realAuth.requireRole('admin')
        expect(await realAuth.listMyOrgs()).toHaveLength(2)
        expect(h.calls.sort()).toEqual(['currentUser', 'users.getOrganizationMembershipList'])
    })

    it('reads past the first page of memberships once too: one call per page, and no more', async () => {
        h.myMemberships = range(130).map((n) => myMembership(n, 'member'))
        const { realAuth } = await import('./auth')
        render.scope = new Map()
        await Promise.all([realAuth.getCurrentUser(), realAuth.listMyOrgs(), realAuth.getCurrentUser()])
        expect(h.calls.filter((call) => call === 'users.getOrganizationMembershipList')).toHaveLength(2)
    })

    it('shares nothing outside a render: a route handler reads on each call', async () => {
        const { realAuth } = await import('./auth')
        await realAuth.getCurrentUser()
        await realAuth.getCurrentUser()
        expect(h.calls).toHaveLength(4)
    })

    it('shares nothing between renders: a removal, a role change or a ban shows on the next request', async () => {
        const { realAuth } = await import('./auth')
        render.scope = new Map()
        expect((await realAuth.getCurrentUser())?.role).toBe('admin')
        // Removed from org-1 (so org-2 becomes the active one), between requests.
        h.myMemberships = [myMembership(2, 'member')]
        expect((await realAuth.getCurrentUser())?.role).toBe('admin')
        render.scope = new Map()
        expect(await realAuth.getCurrentUser()).toMatchObject({ orgSlug: 'org-2', role: 'member' })
        // Banned: Clerk ends the session, but a session token already issued still verifies until it lapses, and Clerk
        // still answers the account, marked banned. The next request reads no one.
        h.user = { ...PAT, banned: true }
        render.scope = new Map()
        expect(await realAuth.getCurrentUser()).toBeNull()
        const { clerkIdentitySource } = await import('./auth')
        expect(await clerkIdentitySource.current()).toBeNull()
    })

    it("sees the render's own writes: switching org, then reading, answers the new org", async () => {
        const { realAuth } = await import('./auth')
        render.scope = new Map()
        expect((await realAuth.getCurrentUser())?.orgSlug).toBe('org-1')
        await realAuth.setActiveOrg('org-2')
        expect(await realAuth.getCurrentUser()).toMatchObject({ orgSlug: 'org-2', role: 'member' })
    })

    it("sees the render's own profile update", async () => {
        const { realAuth } = await import('./auth')
        render.scope = new Map()
        expect((await realAuth.getCurrentUser())?.name).toBe('Pat')
        expect((await realAuth.updateProfile({ name: 'Pat Lane' })).name).toBe('Pat Lane')
        expect((await realAuth.getCurrentUser())?.name).toBe('Pat Lane')
    })

    it('keeps no failed read: the next call in the render asks Clerk again', async () => {
        const { realAuth } = await import('./auth')
        render.scope = new Map()
        h.failNextUserRead = true
        await expect(realAuth.getCurrentUser()).rejects.toThrow('Clerk is down')
        expect((await realAuth.getCurrentUser())?.name).toBe('Pat')
    })

    it.each<[string, (auth: typeof import('./auth')) => Promise<unknown>]>([
        ['getCurrentUser', ({ realAuth }) => realAuth.getCurrentUser()],
        ['requireUser', ({ realAuth }) => realAuth.requireUser()],
        ['signOut', ({ realAuth }) => realAuth.signOut()],
        ['updateProfile', ({ realAuth }) => realAuth.updateProfile({ name: 'Pat Lane' })],
        ['getMember', ({ realAuth }) => realAuth.getMember('depot', 'user_1')],
        ['listMembers', ({ realAuth }) => realAuth.listMembers('depot')],
        ['createInvite', ({ realAuth }) => realAuth.createInvite(INVITE)],
        ['listMyOrgs', ({ realAuth }) => realAuth.listMyOrgs()],
        ['setActiveOrg', ({ realAuth }) => realAuth.setActiveOrg('org-2')],
        ['the identity source, current', ({ clerkIdentitySource }) => clerkIdentitySource.current()],
        ['the identity source, account', ({ clerkIdentitySource }) => clerkIdentitySource.account('user_1')],
    ])('%s calls Clerk for nothing under next dev with keyless mode on, or with no secret key', async (_, call) => {
        const adapter = await import('./auth')
        vi.stubEnv('NODE_ENV', 'development')
        vi.stubEnv('NEXT_PUBLIC_CLERK_KEYLESS_DISABLED', '')
        await expect(call(adapter)).rejects.toThrow(/NEXT_PUBLIC_CLERK_KEYLESS_DISABLED=1/)
        vi.stubEnv('NEXT_PUBLIC_CLERK_KEYLESS_DISABLED', '1')
        vi.stubEnv('CLERK_SECRET_KEY', '')
        await expect(call(adapter)).rejects.toThrow(/Set CLERK_SECRET_KEY/)
        expect([h.authCalls, h.clientCalls, h.calls]).toEqual([0, 0, []])
    })

    // safeinsights/sssb#222's review, A3: a job program, an ops script or a test run is not `next dev`.
    it.each([['test'], [undefined]])(
        'a process with the secret key and NODE_ENV %s, no flag, reads the person and lists a team',
        async (nodeEnv) => {
            vi.stubEnv('NODE_ENV', nodeEnv)
            vi.stubEnv('NEXT_PUBLIC_CLERK_KEYLESS_DISABLED', '')
            h.user = PAT
            h.myMemberships = [myMembership(1, 'admin')]
            h.orgMembers = [member(1, 'member')]
            const { realAuth } = await import('./auth')
            expect((await realAuth.getCurrentUser())?.role).toBe('admin')
            expect(await realAuth.listMembers('depot')).toHaveLength(1)
        },
    )
})
