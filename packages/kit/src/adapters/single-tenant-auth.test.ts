import { describe, expect, it, vi } from 'vitest'
import { abilityActorFromUser } from '../authz/authorize'
import { defineAbilitiesFor } from '../core/abilities'
import type { AuthPort } from '../ports/auth'
import { AuthRequiredError, ForbiddenError } from '../ports/errors'
import type { AuthTenancy } from './auth-tenancy'
import { type ProviderIdentity, singleTenantAuth } from './single-tenant-auth'

/**
 * Single-tenant auth over a stand-in adapter and identity source: what every port method means when the deployment
 * fixes the tenant and the home org. The person here has no metadata and no organization, as a user of a Clerk
 * instance shared with another product would.
 */
const TENANCY: Extract<AuthTenancy, { kind: 'single' }> = {
    kind: 'single',
    tenantSlug: 'harbor',
    homeOrgSlug: 'depot',
    tenantMetadataKey: 'tenantSlug',
}

const NOBODY_SPECIAL: ProviderIdentity = {
    id: 'user_shared',
    name: 'Someone From Elsewhere',
    email: 'someone@example.test',
    locale: 'en',
    tenantClaim: undefined,
}

function setup(identity: ProviderIdentity | null = NOBODY_SPECIAL, accounts: Record<string, string | undefined> = {}) {
    const base = {
        signInPath: vi.fn(() => '/signin'),
        signOut: vi.fn(async () => {}),
        updateProfile: vi.fn(async () => {
            throw new Error('the wrapper reads the user again itself')
        }),
    } as unknown as AuthPort
    const source = {
        current: vi.fn(async () => identity),
        account: vi.fn(async (userId: string) =>
            Object.hasOwn(accounts, userId) ? { tenantClaim: accounts[userId] } : null,
        ),
    }
    return { auth: singleTenantAuth(base, TENANCY, source), base, source }
}

describe('single-tenant auth', () => {
    it('places a signed-in user with no metadata and no org in the configured tenant and home org, with role none', async () => {
        const { auth } = setup()
        expect(await auth.getCurrentUser()).toEqual({
            id: 'user_shared',
            name: 'Someone From Elsewhere',
            email: 'someone@example.test',
            locale: 'en',
            role: 'none',
            tenantSlug: 'harbor',
            orgSlug: 'depot',
            restricted: true,
        })
    })

    it('refuses every role-gated action, and authorize() allows nothing org-scoped', async () => {
        const { auth } = setup()
        await expect(auth.requireRole('member', 'guest', 'restricted')).rejects.toBeInstanceOf(ForbiddenError)
        const user = await auth.requireUser()
        const ability = defineAbilitiesFor(abilityActorFromUser(user, 'org-depot'))
        for (const type of ['Job', 'Membership', 'Org', 'WebhookEndpoint'] as const) {
            for (const action of ['create', 'read', 'update', 'delete', 'manage'] as const) {
                expect(ability.can(action, { type, orgId: 'org-depot' }), `${action} ${type}`).toBe(false)
            }
        }
    })

    it('is no user at all for an account that claims another tenant', async () => {
        const { auth } = setup({ ...NOBODY_SPECIAL, tenantClaim: 'lakeside' })
        expect(await auth.getCurrentUser()).toBeNull()
        await expect(auth.requireUser()).rejects.toBeInstanceOf(AuthRequiredError)
        expect(await auth.listMyOrgs()).toEqual([])
    })

    it('admits an account that claims the configured tenant itself', async () => {
        const { auth } = setup({ ...NOBODY_SPECIAL, tenantClaim: 'harbor' })
        expect((await auth.getCurrentUser())?.tenantSlug).toBe('harbor')
    })

    it('judges a credential as a session: role none in the home org, nothing elsewhere or for another tenant', async () => {
        const { auth } = setup(null, { user_a: undefined, user_b: 'lakeside' })
        expect(await auth.getMember('depot', 'user_a')).toEqual({ role: 'none', restricted: true })
        expect(await auth.getMember('annex', 'user_a')).toBeNull()
        expect(await auth.getMember('depot', 'user_b')).toBeNull()
        expect(await auth.getMember('depot', 'user_gone')).toBeNull()
    })

    it('lists no members and invites no one: membership is implicit', async () => {
        const { auth } = setup()
        expect(await auth.listMembers('depot')).toEqual([])
        await expect(
            auth.createInvite({
                email: 'x@example.test',
                role: 'member',
                orgSlug: 'depot',
                acceptPageUrl: 'http://h/a',
            }),
        ).rejects.toBeInstanceOf(ForbiddenError)
    })

    it('knows one org, the home org, and refuses any other', async () => {
        const { auth } = setup()
        expect(await auth.listMyOrgs()).toEqual([{ slug: 'depot', name: 'depot', role: 'none' }])
        await expect(auth.setActiveOrg('depot')).resolves.toBeUndefined()
        await expect(auth.setActiveOrg('annex')).rejects.toBeInstanceOf(ForbiddenError)
    })

    it('leaves signing in and out, and the profile write, to the adapter, and reads the user again after it', async () => {
        const { auth, base } = setup()
        vi.mocked(base.updateProfile).mockResolvedValueOnce({} as never)
        expect(auth.signInPath('/x')).toBe('/signin')
        await auth.signOut()
        expect(base.signOut).toHaveBeenCalledTimes(1)
        expect((await auth.updateProfile({ name: 'New' })).role).toBe('none')
    })

    it('signed out is signed out', async () => {
        const { auth } = setup(null)
        expect(await auth.getCurrentUser()).toBeNull()
        expect(await auth.listMyOrgs()).toEqual([])
    })
})
