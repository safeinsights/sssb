import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Clerk adapter's reading of the tenant, with Clerk's server SDK replaced: the multi-tenant path reads the tenant
 * from the user's public metadata under the configured key (`tenantSlug` by default, as it always did), and the
 * identity source single-tenant auth uses reads the same key, and no organization, and refuses banned and unknown
 * accounts. Never run against a real Clerk instance (cutover row `auth-dev`).
 */
const h = vi.hoisted(() => ({
    publicMetadata: {} as Record<string, unknown>,
    accounts: {} as Record<string, { banned: boolean; publicMetadata: Record<string, unknown> }>,
    membershipCalls: 0,
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
                            publicMetadata: { role: 'member' },
                        },
                    ],
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

describe("Clerk's identity source, for single-tenant auth", () => {
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
            user_live: { banned: false, publicMetadata: { tenantSlug: 'harbor' } },
            user_banned: { banned: true, publicMetadata: {} },
        }
        const { clerkIdentitySource } = await import('./auth')
        expect(await clerkIdentitySource.account('user_live')).toEqual({ tenantClaim: 'harbor' })
        expect(await clerkIdentitySource.account('user_banned')).toBeNull()
        expect(await clerkIdentitySource.account('user_unknown')).toBeNull()
    })
})

describe('a tenant claim that is not a slug', () => {
    it("is reported as unreadable to single-tenant auth, and as no tenant to multi-tenant's user", async () => {
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
