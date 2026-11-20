import type { Locale } from '../core/locale'
import type { AuthPort, AuthUser, CreatedInvite, MemberStanding, Membership, OrgRef } from '../ports/auth'
import { AuthRequiredError, ForbiddenError } from '../ports/errors'
import type { AuthTenancy } from './auth-tenancy'

type SingleTenancy = Extract<AuthTenancy, { kind: 'single' }>

/** A signed-in person as the identity provider knows them: who they are, and any tenant they claim. */
export interface ProviderIdentity {
    id: string
    name: string
    email: string
    locale: Locale
    /**
     * The account's tenant claim under the metadata key: the slug it names, `undefined` when it names none (the key is
     * absent, null or empty), or `null` when it holds something that is not a slug at all, which is refused.
     */
    tenantClaim: string | null | undefined
}

/** What single mode needs from an auth adapter beyond its port: the provider's facts, with no org or role in them. */
export interface ProviderIdentitySource {
    /** The person signed in on this request, or null. */
    current(): Promise<ProviderIdentity | null>
    /**
     * Another account by id: null when the provider has none, or would not let it act (a banned account). For a
     * person who arrived without a session (an API token, an inbound email), so they are judged as now.
     */
    account(userId: string): Promise<Pick<ProviderIdentity, 'tenantClaim'> | null>
}

/**
 * Single-tenant auth (./auth-tenancy.ts): the adapter's sign-in and accounts, with the tenant and the org fixed by the
 * deployment and every person's role `none`. Both adapters are wrapped by this one module, so the mode means the same
 * in a simulated world as in a deployment.
 *
 * What each method means here, and why:
 * - `getCurrentUser`: the configured tenant and home org, role `none`, restricted. A person whose account names a
 *   different tenant under the metadata key, or holds there something that is not a slug, is no user at all: that is a
 *   multi-tenant instance switched to this mode by mistake, and admitting them would put another tenant's people in
 *   this one.
 * - `requireRole`: as ever, so every role-gated action is refused to `none`.
 * - `getMember`: the same standing, `none`, for an account the provider still has in the home org; null for any other
 *   org, an unknown or banned account, or one whose claim names another tenant or is not a slug. A credential is
 *   judged as a session is.
 * - `listMembers`: empty. Membership is implicit, and listing the provider's users would enumerate everyone on the
 *   instance, another product's users included. So nobody is an admin, and a notification fanned out to an org's
 *   admins reaches no one.
 * - `createInvite`: refused. Anyone the provider signs in is already placed in the home org, so there is no one to
 *   invite; an app adds people through its provider's own sign-up.
 * - `listMyOrgs`: the home org alone, named by its slug (this module reads no database). `setActiveOrg`: the home org
 *   is accepted and changes nothing; any other is refused.
 * - `signInPath`, `signOut`, `updateProfile`: the adapter's own.
 */
export function singleTenantAuth(base: AuthPort, tenancy: SingleTenancy, source: ProviderIdentitySource): AuthPort {
    const sameTenant = (claim: string | null | undefined) => claim === undefined || claim === tenancy.tenantSlug

    const port: AuthPort = {
        async getCurrentUser(): Promise<AuthUser | null> {
            const identity = await source.current()
            // Refused without signing out: this runs while server components render, where a session cookie cannot be
            // changed, and once per call. The person stays signed in to the provider and is no user here.
            if (!identity || !sameTenant(identity.tenantClaim)) return null
            return {
                id: identity.id,
                name: identity.name,
                email: identity.email,
                locale: identity.locale,
                role: 'none',
                tenantSlug: tenancy.tenantSlug,
                orgSlug: tenancy.homeOrgSlug,
                restricted: true,
            }
        },

        async requireUser(): Promise<AuthUser> {
            const user = await port.getCurrentUser()
            if (!user) throw new AuthRequiredError()
            return user
        },

        async requireRole(...roles): Promise<AuthUser> {
            const user = await port.requireUser()
            if (!roles.includes(user.role)) throw new ForbiddenError(`requires one of: ${roles.join(', ')}`)
            return user
        },

        signInPath(returnTo?: string): string {
            return base.signInPath(returnTo)
        },

        async signOut(): Promise<void> {
            await base.signOut()
        },

        async updateProfile(update): Promise<AuthUser> {
            await port.requireUser()
            await base.updateProfile(update)
            return port.requireUser()
        },

        async getMember(orgSlug: string, userId: string): Promise<MemberStanding | null> {
            if (orgSlug !== tenancy.homeOrgSlug) return null
            const account = await source.account(userId)
            if (!account || !sameTenant(account.tenantClaim)) return null
            return { role: 'none', restricted: true }
        },

        async listMembers(): Promise<Membership[]> {
            return []
        },

        async createInvite(): Promise<CreatedInvite> {
            throw new ForbiddenError(
                'single-tenant auth places everyone the identity provider signs in in the home org, so there is no ' +
                    'one to invite (AUTH_TENANCY=single)',
            )
        },

        async listMyOrgs(): Promise<OrgRef[]> {
            const user = await port.getCurrentUser()
            if (!user) return []
            return [{ slug: tenancy.homeOrgSlug, name: tenancy.homeOrgSlug, role: 'none' }]
        },

        async setActiveOrg(orgSlug: string): Promise<void> {
            await port.requireUser()
            if (orgSlug !== tenancy.homeOrgSlug) throw new ForbiddenError(`no membership in org: ${orgSlug}`)
        },
    }
    return port
}
