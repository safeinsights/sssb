import { staffOrgSlug } from '@sssb/app-config/abilities'
import { describe, expect, it, vi } from 'vitest'
import { abilityActorFromUser } from '../authz/authorize'
import { defineAbilitiesFor } from '../core/abilities'
import type { AuthPort, AuthUser } from '../ports/auth'
import { AuthRequiredError, ForbiddenError } from '../ports/errors'
import type { AuthSettings } from './auth-tenancy'
import { configuredAuth, type ProviderAccount, type ProviderIdentity } from './configured-auth'

/**
 * The auth port as the two settings place people, over a stand-in adapter and identity source. The person here has
 * no metadata and no organization, as a user of an identity-provider instance shared with another product would.
 * The stand-in adapter is the provider's organizations: it answers with a membership in `depot` as `member`.
 */
const SINGLE = { kind: 'single', tenantSlug: 'harbor' } as const
const MULTI = { kind: 'multi' } as const
const PROVIDER = { kind: 'provider' } as const
const FIXED = { kind: 'fixed', homeOrgSlug: 'depot', role: 'none' } as const
const STAFF_ORG = staffOrgSlug

const NOBODY_SPECIAL: ProviderIdentity = {
    id: 'user_shared',
    name: 'Someone From Elsewhere',
    email: 'someone@example.test',
    locale: 'en',
    tenantClaim: undefined,
}

const PROVIDER_USER: AuthUser = {
    id: 'user_shared',
    name: 'Someone From Elsewhere',
    email: 'someone@example.test',
    locale: 'en',
    role: 'member',
    tenantSlug: '',
    orgSlug: 'depot',
    restricted: false,
}

function setup(
    settings: Pick<AuthSettings, 'tenancy' | 'orgSource'>,
    identity: ProviderIdentity | null = NOBODY_SPECIAL,
    accounts: Record<string, string | null | undefined> = {},
) {
    const base = {
        getCurrentUser: vi.fn(async () =>
            identity ? { ...PROVIDER_USER, tenantSlug: identity.tenantClaim ?? '' } : null,
        ),
        getMember: vi.fn(async () => ({ role: 'member', restricted: false })),
        listMembers: vi.fn(async () => [
            { id: 'user_admin', name: 'Admin', email: 'a@example.test', role: 'admin', status: 'active' },
        ]),
        createInvite: vi.fn(async () => ({ id: 'inv_1' })),
        listMyOrgs: vi.fn(async () => [{ slug: 'depot', name: 'Depot', role: 'member' }]),
        setActiveOrg: vi.fn(async () => {}),
        signInPath: vi.fn(() => '/signin'),
        signOut: vi.fn(async () => {}),
        updateProfile: vi.fn(async () => {
            throw new Error('the wrapper reads the user again itself')
        }),
    } as unknown as AuthPort
    const source = {
        current: vi.fn(async () => identity),
        account: vi.fn(async (userId: string): Promise<ProviderAccount | null> =>
            Object.hasOwn(accounts, userId)
                ? { tenantClaim: accounts[userId], name: `Name ${userId}`, email: `${userId}@example.test` }
                : null,
        ),
    }
    const auth = configuredAuth(base, { ...settings, tenantMetadataKey: 'tenantSlug' }, source, STAFF_ORG)
    return { auth, base, source }
}

const INVITE = { email: 'x@example.test', role: 'member', orgSlug: 'depot', acceptPageUrl: 'http://h/a' } as const

describe('the default settings', () => {
    it('are the adapter itself, untouched', () => {
        const { auth, base } = setup({ tenancy: MULTI, orgSource: PROVIDER })
        expect(auth).toBe(base)
    })
})

describe('a single tenancy over the provider organizations: only the tenant changes', () => {
    const settings = { tenancy: SINGLE, orgSource: PROVIDER }

    it("places the provider's user, with their own org and role, in the configured tenant", async () => {
        const { auth } = setup(settings)
        expect(await auth.getCurrentUser()).toEqual({ ...PROVIDER_USER, tenantSlug: 'harbor' })
    })

    it("lists the provider's members, invites through it, and lists and switches the provider's orgs", async () => {
        const { auth, base } = setup(settings)
        expect(await auth.listMembers('depot')).toEqual(await base.listMembers('depot'))
        await auth.createInvite(INVITE)
        expect(base.createInvite).toHaveBeenCalledWith(INVITE)
        expect(await auth.listMyOrgs()).toEqual([{ slug: 'depot', name: 'Depot', role: 'member' }])
        await auth.setActiveOrg('annex')
        expect(base.setActiveOrg).toHaveBeenCalledWith('annex')
    })

    it("judges a credential by the provider's membership, after the tenant guard", async () => {
        const { auth } = setup(settings, null, { user_a: undefined, user_b: 'lakeside' })
        expect(await auth.getMember('depot', 'user_a')).toEqual({ role: 'member', restricted: false })
        expect(await auth.getMember('depot', 'user_b')).toBeNull()
        expect(await auth.getMember('depot', 'user_gone')).toBeNull()
    })

    it('asks the provider for the membership first, so a non-member costs what it did on the bare adapter', async () => {
        const { auth, base, source } = setup(settings, null, { user_a: undefined })
        vi.mocked(base.getMember).mockResolvedValueOnce(null)
        expect(await auth.getMember('annex', 'user_a')).toBeNull()
        expect(source.account).not.toHaveBeenCalled()
    })

    it('is no user at all for an account that claims another tenant, and changes no session saying so', async () => {
        const { auth, base } = setup(settings, { ...NOBODY_SPECIAL, tenantClaim: 'lakeside' })
        expect(await auth.getCurrentUser()).toBeNull()
        // Server components call this while they render, where a session cookie cannot be changed.
        expect(base.signOut).not.toHaveBeenCalled()
        await expect(auth.requireUser()).rejects.toBeInstanceOf(AuthRequiredError)
        expect(await auth.listMyOrgs()).toEqual([])
        await expect(auth.createInvite(INVITE)).rejects.toBeInstanceOf(AuthRequiredError)
        await expect(auth.setActiveOrg('depot')).rejects.toBeInstanceOf(AuthRequiredError)
        expect(base.createInvite).not.toHaveBeenCalled()
        expect(base.setActiveOrg).not.toHaveBeenCalled()
    })

    it('refuses an account whose claim is not a slug at all, in session and as a credential', async () => {
        const { auth } = setup(settings, { ...NOBODY_SPECIAL, tenantClaim: null }, { user_odd: null })
        expect(await auth.getCurrentUser()).toBeNull()
        expect(await auth.getMember('depot', 'user_odd')).toBeNull()
    })

    it('admits an account that claims the configured tenant itself', async () => {
        const { auth } = setup(settings, { ...NOBODY_SPECIAL, tenantClaim: 'harbor' })
        expect((await auth.getCurrentUser())?.tenantSlug).toBe('harbor')
    })

    it("is no user when the adapter's signed-in account is not the one the source read", async () => {
        const { auth, base } = setup(settings)
        vi.mocked(base.getCurrentUser).mockResolvedValueOnce({ ...PROVIDER_USER, id: 'user_other' })
        expect(await auth.getCurrentUser()).toBeNull()
    })
})

describe('a fixed org source: everyone in the home org, with the configured role', () => {
    const settings = { tenancy: SINGLE, orgSource: FIXED }

    it('places a signed-in user with no organization in the home org, role none, in the tenant', async () => {
        const { auth, base } = setup(settings)
        expect(await auth.getCurrentUser()).toEqual({
            ...PROVIDER_USER,
            role: 'none',
            tenantSlug: 'harbor',
            orgSlug: 'depot',
            restricted: true,
        })
        // No membership call: the adapter's own user, with its organizations, is never read.
        expect(base.getCurrentUser).not.toHaveBeenCalled()
    })

    it('gives the configured role, and no other, whatever the provider holds', async () => {
        const { auth } = setup({ tenancy: SINGLE, orgSource: { ...FIXED, role: 'restricted' } })
        const user = await auth.requireUser()
        expect(user).toMatchObject({ role: 'restricted', restricted: true, orgSlug: 'depot' })
        await expect(auth.requireRole('admin', 'staff', 'member', 'guest')).rejects.toBeInstanceOf(ForbiddenError)
    })

    it('with role none, refuses every role-gated action, and authorize() allows nothing org-scoped', async () => {
        const { auth } = setup(settings)
        await expect(auth.requireRole('member', 'guest', 'restricted')).rejects.toBeInstanceOf(ForbiddenError)
        const user = await auth.requireUser()
        const ability = defineAbilitiesFor(abilityActorFromUser(user, 'org-depot'))
        for (const type of ['Job', 'Membership', 'Org', 'WebhookEndpoint'] as const) {
            for (const action of ['create', 'read', 'update', 'delete', 'manage'] as const) {
                expect(ability.can(action, { type, orgId: 'org-depot' }), `${action} ${type}`).toBe(false)
            }
        }
    })

    it('with role restricted, reads what a restricted member reads and writes nothing org-scoped', async () => {
        const { auth } = setup({ tenancy: SINGLE, orgSource: { ...FIXED, role: 'restricted' } })
        const ability = defineAbilitiesFor(abilityActorFromUser(await auth.requireUser(), 'org-depot'))
        expect(ability.can('read', { type: 'Job', orgId: 'org-depot' })).toBe(true)
        expect(ability.can('create', { type: 'Job', orgId: 'org-depot' })).toBe(false)
        expect(ability.can('create', { type: 'Membership', orgId: 'org-depot' })).toBe(false)
    })

    it('judges a credential as a session, and says how to reach the person: nothing elsewhere', async () => {
        const { auth, base } = setup(settings, null, { user_a: undefined })
        expect(await auth.getMember('depot', 'user_a')).toEqual({
            role: 'none',
            restricted: true,
            name: 'Name user_a',
            email: 'user_a@example.test',
        })
        expect(await auth.getMember('annex', 'user_a')).toBeNull()
        expect(await auth.getMember('depot', 'user_gone')).toBeNull()
        expect(base.getMember).not.toHaveBeenCalled()
    })

    it('lists no members and invites no one: membership is implicit', async () => {
        const { auth, base } = setup(settings)
        expect(await auth.listMembers('depot')).toEqual([])
        await expect(auth.createInvite(INVITE)).rejects.toBeInstanceOf(ForbiddenError)
        expect(base.listMembers).not.toHaveBeenCalled()
    })

    it('knows one org, the home org, and refuses any other', async () => {
        const { auth } = setup(settings)
        expect(await auth.listMyOrgs()).toEqual([{ slug: 'depot', name: 'depot', role: 'none' }])
        await expect(auth.setActiveOrg('depot')).resolves.toBeUndefined()
        await expect(auth.setActiveOrg('annex')).rejects.toBeInstanceOf(ForbiddenError)
    })

    it('leaves signing in and out, and the profile write, to the adapter, and reads the user again after it', async () => {
        const { auth, base } = setup(settings)
        vi.mocked(base.updateProfile).mockResolvedValueOnce({} as never)
        expect(auth.signInPath('/x')).toBe('/signin')
        await auth.signOut()
        expect(base.signOut).toHaveBeenCalledTimes(1)
        expect((await auth.updateProfile({ name: 'New' })).role).toBe('none')
    })

    it('signed out is signed out', async () => {
        const { auth } = setup(settings, null)
        expect(await auth.getCurrentUser()).toBeNull()
        expect(await auth.listMyOrgs()).toEqual([])
    })

    it('refuses to be built when it would hand everyone the staff org with standing', () => {
        expect(() =>
            setup({ tenancy: SINGLE, orgSource: { kind: 'fixed', homeOrgSlug: STAFF_ORG, role: 'restricted' } }),
        ).toThrow(/would wield manage-all/)
        const { auth } = setup({ tenancy: SINGLE, orgSource: { kind: 'fixed', homeOrgSlug: STAFF_ORG, role: 'none' } })
        expect(auth).toBeDefined()
    })

    it('with role none in the staff org, never wields manage-all', async () => {
        const { auth } = setup({ tenancy: SINGLE, orgSource: { kind: 'fixed', homeOrgSlug: STAFF_ORG, role: 'none' } })
        const user = await auth.requireUser()
        expect(abilityActorFromUser(user, 'org-staff').manageAll).toBe(false)
    })
})

describe('a fixed org source keeps the tenant guard', () => {
    const settings = { tenancy: SINGLE, orgSource: FIXED }

    it('refuses to be built with a multi tenancy', () => {
        expect(() => setup({ tenancy: MULTI, orgSource: FIXED })).toThrow(/needs a single tenancy/)
    })

    it('still refuses another tenant, in session and as a credential', async () => {
        const { auth } = setup(settings, { ...NOBODY_SPECIAL, tenantClaim: 'lakeside' }, { user_b: 'lakeside' })
        expect(await auth.getCurrentUser()).toBeNull()
        expect(await auth.getMember('depot', 'user_b')).toBeNull()
    })
})
