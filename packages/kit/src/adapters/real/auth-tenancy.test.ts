import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Clerk adapter's reading of the tenant, with Clerk's server SDK replaced: the multi-tenant path reads the tenant
 * from the user's public metadata under the configured key (`tenantSlug` by default, as it always did), and the
 * identity source single-tenant auth uses reads the same key, and no organization, and refuses banned and unknown
 * accounts. Never run against a real Clerk instance (cutover row `auth-dev`).
 */
const h = vi.hoisted(() => ({
    publicMetadata: {} as Record<string, unknown>,
    accounts: {} as Record<
        string,
        {
            banned: boolean
            publicMetadata: Record<string, unknown>
            fullName?: string
            primaryEmailAddress?: { emailAddress: string }
        }
    >,
    membershipCalls: 0,
    membershipRole: 'member' as unknown,
}))

vi.mock('@clerk/nextjs/server', () => ({
    auth: async () => ({ userId: 'user_1' }),
    currentUser: async () => ({
        fullName: 'Ada Lane',
        primaryEmailAddress: { emailAddress: 'ada@example.test' },
        publicMetadata: h.publicMetadata,
        unsafeMetadata: {},
    }),
    clerkClient: async () => ({
        users: {
            getOrganizationMembershipList: async () => {
                h.membershipCalls += 1
                return {
                    data: [
                        {
                            organization: { slug: 'depot', id: 'org_1', name: 'Depot' },
                            publicMetadata: { role: h.membershipRole },
                        },
                    ],
                    totalCount: 1,
                }
            },
            getUser: async (userId: string) => {
                const account = h.accounts[userId]
                if (!account) throw { status: 404 }
                return account
            },
        },
    }),
}))
vi.mock('@clerk/nextjs/errors', () => ({
    isClerkAPIResponseError: (error: unknown) => typeof error === 'object' && error !== null && 'status' in error,
}))

beforeEach(() => {
    h.publicMetadata = {}
    h.accounts = {}
    h.membershipCalls = 0
    h.membershipRole = 'member'
    // What the adapter requires before it reads a session under next dev, and in any process without a secret key
    // (./clerk-keyless.ts).
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_1')
    vi.stubEnv('NEXT_PUBLIC_CLERK_KEYLESS_DISABLED', '1')
})
afterEach(() => {
    vi.unstubAllEnvs()
})

describe('the Clerk adapter, multi-tenant', () => {
    it('reads the tenant from publicMetadata.tenantSlug when no key is configured, as before', async () => {
        h.publicMetadata = { tenantSlug: 'harbor', siteSlug: 'lakeside' }
        const { realAuth } = await import('./auth')
        expect(await realAuth.getCurrentUser()).toMatchObject({
            tenantSlug: 'harbor',
            orgSlug: 'depot',
            role: 'member',
        })
    })

    it('reads it under AUTH_TENANT_METADATA_KEY when one is configured, and nothing else', async () => {
        vi.stubEnv('AUTH_TENANT_METADATA_KEY', 'siteSlug')
        h.publicMetadata = { tenantSlug: 'harbor', siteSlug: 'lakeside' }
        const { realAuth } = await import('./auth')
        expect((await realAuth.getCurrentUser())?.tenantSlug).toBe('lakeside')
    })

    it('has no tenant when the key holds no string', async () => {
        h.publicMetadata = { tenantSlug: 7 }
        const { realAuth } = await import('./auth')
        expect((await realAuth.getCurrentUser())?.tenantSlug).toBe('')
    })
})

describe("a membership's role, as Clerk holds it", () => {
    // A membership whose role string is already `none` is read as `none`: no standing, refused every org read. Before
    // the role existed it was no role and fell back to `guest`. Kept deliberately (fail closed): SSSB never writes
    // `none` on a membership (an invite cannot grant it), so it is an operator's own word, and reading it as `guest`
    // would grant more than they wrote.
    it('reads none as none, with no standing, and an unknown role as guest', async () => {
        const { realAuth } = await import('./auth')
        h.membershipRole = 'none'
        expect(await realAuth.getCurrentUser()).toMatchObject({ role: 'none', restricted: true })
        h.membershipRole = 'owner'
        expect(await realAuth.getCurrentUser()).toMatchObject({ role: 'guest', restricted: false })
    })
})

describe("Clerk's identity source, for the auth settings", () => {
    it('reads who is signed in and their tenant claim under the key, with no membership call', async () => {
        vi.stubEnv('AUTH_TENANT_METADATA_KEY', 'siteSlug')
        h.publicMetadata = { siteSlug: 'harbor', locale: 'es' }
        const { clerkIdentitySource } = await import('./auth')
        expect(await clerkIdentitySource.current()).toEqual({
            id: 'user_1',
            name: 'Ada Lane',
            email: 'ada@example.test',
            locale: 'es',
            tenantClaim: 'harbor',
        })
        expect(h.membershipCalls).toBe(0)
    })

    it('refuses a banned or unknown account, and reports a live one with its claim', async () => {
        h.accounts = {
            user_live: {
                banned: false,
                publicMetadata: { tenantSlug: 'harbor' },
                fullName: 'Lee Live',
                primaryEmailAddress: { emailAddress: 'lee@example.test' },
            },
            user_banned: { banned: true, publicMetadata: {} },
        }
        const { clerkIdentitySource } = await import('./auth')
        expect(await clerkIdentitySource.account('user_live')).toEqual({
            tenantClaim: 'harbor',
            name: 'Lee Live',
            email: 'lee@example.test',
        })
        expect(await clerkIdentitySource.account('user_banned')).toBeNull()
        expect(await clerkIdentitySource.account('user_unknown')).toBeNull()
    })
})

describe('a tenant claim that is not a slug', () => {
    it("is reported as unreadable to a single tenancy, and as no tenant to a multi tenancy's user", async () => {
        h.publicMetadata = { tenantSlug: ['harbor'] }
        const { clerkIdentitySource, realAuth } = await import('./auth')
        expect((await clerkIdentitySource.current())?.tenantClaim).toBeNull()
        expect((await realAuth.getCurrentUser())?.tenantSlug).toBe('')
    })

    it('is no claim when absent, null or empty', async () => {
        const { clerkIdentitySource } = await import('./auth')
        for (const value of [undefined, null, '']) {
            h.publicMetadata = { tenantSlug: value }
            expect((await clerkIdentitySource.current())?.tenantClaim).toBeUndefined()
        }
    })
})
