import { isRestricted } from '../core/roles'
import type { Locale } from '../core/locale'
import type { AuthPort, AuthRefusal, AuthUser, CreatedInvite, MemberStanding, Membership, OrgRef } from '../ports/auth'
import { AuthRequiredError, ForbiddenError } from '../ports/errors'
import { type AuthSettings, fixedOrgProblem } from './auth-tenancy'

/** A signed-in person as the identity provider knows them: who they are, and any tenant they claim. */
export interface ProviderIdentity {
    id: string
    name: string
    email: string
    locale: Locale
    /**
     * The account's tenant claim under the metadata key: the slug it names, `undefined` when it names none (the key is
     * absent, null or empty), or `null` when it holds something that is not a slug at all, which single tenancy
     * refuses.
     */
    tenantClaim: string | null | undefined
}

/** Another account, as `getMember` needs it: its tenant claim, and how to reach it. */
export type ProviderAccount = Pick<ProviderIdentity, 'tenantClaim' | 'email'> & { name: string | null }

/** What the auth settings need from an adapter beyond its port: the provider's facts, with no org or role in them. */
export interface ProviderIdentitySource {
    /** The person signed in on this request, or null. */
    current(): Promise<ProviderIdentity | null>
    /**
     * Another account by id: null when the provider has none, or would not let it act (a banned account). For a
     * person who arrived without a session (an API token, an inbound email), so they are judged as now.
     */
    account(userId: string): Promise<ProviderAccount | null>
}

/**
 * The auth port as the deployment's settings place people (./auth-tenancy.ts), over either adapter, the fake or Clerk,
 * so the settings mean the same in a simulated world as in a deployment. On the defaults (multi tenancy, the provider's
 * organizations) it is the adapter itself, untouched.
 *
 * **Single tenancy changes where the tenant comes from, and nothing else.** The person's tenant is the configured one,
 * and a person whose account names a different tenant under the metadata key, or holds there something that is not a
 * slug, is no user at all, and has no standing anywhere as a credential (`getMember`): that is a multi-tenant instance
 * switched to this mode by mistake, and admitting them would put another tenant's people in this one. Refused without
 * signing out: this runs while server components render, where a session cookie cannot be changed, and on a shared
 * instance it would end their session in the other product. `refusal` says why to the sign-in page, which offers the
 * person an explicit sign-out (`@sssb/kit/components/auth/account-refused`). Over the provider's organizations, every method is
 * otherwise the adapter's, with its organizations, roles, members and invitations; the ones that act for the signed-in
 * person (`updateProfile`, `createInvite`, `listMyOrgs`, `setActiveOrg`) run the tenant guard first, and `getMember`
 * runs it after the provider's membership.
 *
 * **A fixed org source places everyone in one org with one role**, and what each method means follows from it:
 * - `getCurrentUser`: the home org and the configured role, whatever the provider's metadata says. No role is read from
 *   the provider: on an instance shared with another product, that product may write the same metadata for its own
 *   reasons.
 * - `getMember`: the same standing, with the account's name and email, for an account the provider still has, in the
 *   home org; null for any other org, and for an unknown or banned account.
 * - `listMembers`: empty. Membership is implicit, and listing the provider's users would enumerate everyone on the
 *   instance, another product's users included, and mail them. So no one is an org admin: the end of a job submitted
 *   with a requester goes to that person instead (../server-lib/notify.ts `notifyJobTerminal`), and an app addresses
 *   its own notifications to the people it knows. SSSB's own rules let neither offered role submit a `Job` (create
 *   needs a non-restricted member), so such a job is one the app's own rules let the person start.
 * - `createInvite`: refused. Anyone the provider signs in is already placed in the home org; an app adds people through
 *   its provider's own sign-up.
 * - `listMyOrgs`: the home org alone, named by its org row's name, which the caller supplies a lookup for (`orgName`;
 *   the slug when the row is missing). `setActiveOrg`: the home org
 *   is accepted and changes nothing; any other is refused.
 *
 * `signInPath` and `signOut` are always the adapter's, and `updateProfile` writes through it after the guard.
 */
export function configuredAuth(
    base: AuthPort,
    settings: AuthSettings,
    source: ProviderIdentitySource,
    staffOrgSlug: string,
    /**
     * The display name of an org, by its tenant's slug and its own, or null when there is no such row: how a fixed org
     * source names its home org, since this module knows it only by slug. Left out (a test), the slug is the name.
     */
    orgName?: (tenantSlug: string, orgSlug: string) => Promise<string | null>,
): AuthPort {
    const { tenancy, orgSource } = settings
    if (tenancy.kind === 'multi' && orgSource.kind === 'provider') return base
    const problem = fixedOrgProblem(orgSource, staffOrgSlug)
    if (problem) throw new Error(problem)
    // authSettings refuses this pairing; refused again here, for a caller that builds the settings itself.
    if (orgSource.kind === 'fixed' && tenancy.kind !== 'single')
        throw new Error('a fixed org source needs a single tenancy')

    const admitted = (claim: string | null | undefined) =>
        tenancy.kind === 'multi' || claim === undefined || claim === tenancy.tenantSlug
    const fixed = orgSource.kind === 'fixed' ? orgSource : null
    const fixedRestricted = fixed ? isRestricted(undefined, fixed.role) : false

    const port: AuthPort = {
        async getCurrentUser(): Promise<AuthUser | null> {
            const identity = await source.current()
            if (!identity || !admitted(identity.tenantClaim)) return null
            if (fixed) {
                return {
                    id: identity.id,
                    name: identity.name,
                    email: identity.email,
                    locale: identity.locale,
                    role: fixed.role,
                    // A fixed org source needs a single tenancy (refused above otherwise).
                    tenantSlug: tenancy.kind === 'single' ? tenancy.tenantSlug : '',
                    orgSlug: fixed.homeOrgSlug,
                    restricted: fixedRestricted,
                }
            }
            // Single tenancy over the provider's organizations: the adapter's user, in the configured tenant. The
            // adapter reads the signed-in account again, so on Clerk this may be a second user request per call (the
            // cutover row `auth-tenancy` says to measure it).
            const user = await base.getCurrentUser()
            if (!user || user.id !== identity.id) return null
            return tenancy.kind === 'single' ? { ...user, tenantSlug: tenancy.tenantSlug } : user
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
            if (!fixed) {
                // The provider's organizations: its own membership first, so a non-member costs what it always did,
                // then the tenant guard.
                const standing = await base.getMember(orgSlug, userId)
                if (!standing) return null
                const account = await source.account(userId)
                return account && admitted(account.tenantClaim) ? standing : null
            }
            if (orgSlug !== fixed.homeOrgSlug) return null
            const account = await source.account(userId)
            if (!account || !admitted(account.tenantClaim)) return null
            return { role: fixed.role, restricted: fixedRestricted, name: account.name, email: account.email }
        },

        async listMembers(orgSlug: string): Promise<Membership[]> {
            return fixed ? [] : base.listMembers(orgSlug)
        },

        async createInvite(invite): Promise<CreatedInvite> {
            if (fixed) {
                throw new ForbiddenError(
                    'a fixed org source places everyone the identity provider signs in in the home org, so there is ' +
                        'no one to invite (AUTH_ORG_SOURCE=fixed)',
                )
            }
            // The adapter checks only that someone is signed in; the tenant guard is this port's.
            await port.requireUser()
            return base.createInvite(invite)
        },

        async listMyOrgs(): Promise<OrgRef[]> {
            const user = await port.getCurrentUser()
            if (!user) return []
            if (fixed) {
                // The org row's name, read per call (a rename shows at once); the slug when the row is missing,
                // which the cutover row `auth-tenancy` says to create.
                const name = (await orgName?.(user.tenantSlug, fixed.homeOrgSlug)) ?? fixed.homeOrgSlug
                return [{ slug: fixed.homeOrgSlug, name, role: fixed.role }]
            }
            return base.listMyOrgs()
        },

        async refusal(): Promise<AuthRefusal | null> {
            // Read only on the sign-in page, never per request: the guard's own reason, from the same identity read.
            const identity = await source.current()
            return identity && !admitted(identity.tenantClaim) ? { reason: 'other-tenant' } : null
        },

        async setActiveOrg(orgSlug: string): Promise<void> {
            await port.requireUser()
            if (!fixed) return base.setActiveOrg(orgSlug)
            if (orgSlug !== fixed.homeOrgSlug) throw new ForbiddenError(`no membership in org: ${orgSlug}`)
        },
    }
    return port
}
