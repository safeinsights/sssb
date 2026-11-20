import { isClerkAPIResponseError } from '@clerk/nextjs/errors'
import { auth, clerkClient, currentUser } from '@clerk/nextjs/server'
import { DEFAULT_LOCALE, LOCALES, type Locale } from '../../core/locale'
import { isRestricted, isRole, type Role } from '../../core/roles'
import type {
    AuthPort,
    AuthUser,
    CreatedInvite,
    InviteInput,
    Membership,
    MemberStanding,
    OrgRef,
    ProfileUpdate,
} from '../../ports/auth'
import { AuthRequiredError, ForbiddenError } from '../../ports/errors'

/**
 * Clerk headless adapter (ADR-0003). Clerk organizations ARE our orgs
 * (product copy: "teams"); our org slug === Clerk org slug (no mapping layer). The tenant (site) is
 * ambient and lives in user publicMetadata.tenantSlug — one Clerk instance per tenant in prod, so
 * every org a user sees belongs to their tenant. The ACTIVE org rides in unsafeMetadata.currentOrgSlug,
 * and the request-time role comes from that org membership's publicMetadata.role (role is per-org).
 *
 * AUTHORED — CUTOVER (`auth-dev`): typechecked against @clerk/nextjs, never run against a real
 * Clerk instance. Verify the full port contract suite against the dev instance at cutover.
 * Cutover perf checkpoint: getCurrentUser now issues an extra getOrganizationMembershipList per
 * request to resolve the active-org role — measure and cache if hot.
 */

interface AppPublicMetadata {
    role?: string
    locale?: string
    restricted?: boolean
    tenantSlug?: string
}

/**
 * The role a membership or invitation records, or `guest` when it records none (or one this app does not know): the
 * least privilege, and the same answer everywhere, so the switcher and the member list never show a role the session
 * does not have.
 */
function roleFrom(metadata: unknown): Role {
    const role = (metadata as AppPublicMetadata)?.role
    return role && isRole(role) ? role : 'guest'
}

/** The accept page as a path (with any query), for Clerk to resolve against the instance's own domain. */
function acceptPagePath(acceptPageUrl: string): string {
    const url = new URL(acceptPageUrl)
    return `${url.pathname}${url.search}`
}

/** Clerk's list calls answer a page at a time; this is the page size the adapter asks for. */
const PAGE_SIZE = 100

/**
 * Every row of a Clerk list, read a page at a time. A list read as one page would silently drop whoever is past it: a
 * team's 101st member from its notifications, or a person's 101st org from their switcher.
 */
async function allPages<T>(
    page: (params: { limit: number; offset: number }) => Promise<{ data: T[]; totalCount: number }>,
): Promise<T[]> {
    const rows: T[] = []
    for (;;) {
        const { data, totalCount } = await page({ limit: PAGE_SIZE, offset: rows.length })
        rows.push(...data)
        if (data.length < PAGE_SIZE || rows.length >= totalCount) return rows
    }
}

/** A display name the auth port accepts: a string with something in it, at most 256 characters (Clerk's own limit). */
function isProfileName(name: unknown): name is string {
    return typeof name === 'string' && name.trim() !== '' && name.length <= 256
}

async function organizationIdForSlug(slug: string): Promise<string> {
    const client = await clerkClient()
    const org = await client.organizations.getOrganization({ slug })
    return org.id
}

export const realAuth: AuthPort = {
    async getCurrentUser(): Promise<AuthUser | null> {
        const { userId } = await auth()
        if (!userId) return null
        const user = await currentUser()
        if (!user) return null
        const metadata = (user.publicMetadata ?? {}) as AppPublicMetadata
        const locale = LOCALES.includes(metadata.locale as Locale) ? (metadata.locale as Locale) : DEFAULT_LOCALE

        // Resolve the active org membership: the remembered currentOrgSlug if still a membership,
        // else the first one. Role comes from that membership (per-org), not the user object.
        const client = await clerkClient()
        const memberships = await allPages((page) => client.users.getOrganizationMembershipList({ userId, ...page }))
        const currentOrgSlug = (user.unsafeMetadata as { currentOrgSlug?: string })?.currentOrgSlug
        const active =
            memberships.find((m) => (m.organization.slug ?? m.organization.id) === currentOrgSlug) ?? memberships[0]

        const role = roleFrom(active?.publicMetadata)
        return {
            id: userId,
            name: user.fullName ?? user.primaryEmailAddress?.emailAddress ?? userId,
            email: user.primaryEmailAddress?.emailAddress ?? '',
            role,
            locale,
            // Ambient site claim — never the active org's business.
            tenantSlug: metadata.tenantSlug ?? '',
            orgSlug: active ? (active.organization.slug ?? active.organization.id) : '',
            restricted: isRestricted(metadata.restricted, role),
        }
    },

    async requireUser(): Promise<AuthUser> {
        const user = await this.getCurrentUser()
        if (!user) throw new AuthRequiredError()
        return user
    },

    async requireRole(...roles: Role[]): Promise<AuthUser> {
        const user = await this.requireUser()
        if (!roles.includes(user.role)) throw new ForbiddenError(`requires one of: ${roles.join(', ')}`)
        return user
    },

    signInPath(returnTo?: string): string {
        return returnTo ? `/signin?returnTo=${encodeURIComponent(returnTo)}` : '/signin'
    },

    async signOut(): Promise<void> {
        // Server-side revocation; the client additionally calls Clerk's signOut for local state.
        const { sessionId } = await auth()
        if (!sessionId) return
        const client = await clerkClient()
        await client.sessions.revokeSession(sessionId)
    },

    async updateProfile(update: ProfileUpdate): Promise<AuthUser> {
        const { userId } = await auth()
        if (!userId) throw new AuthRequiredError()
        // Same guards the fake adapter enforces, and as early: before any write, so a refused update changes nothing.
        if (update.name !== undefined && !isProfileName(update.name)) throw new ForbiddenError('invalid name')
        if (update.locale !== undefined && !LOCALES.includes(update.locale)) throw new ForbiddenError('unknown locale')
        const client = await clerkClient()
        if (update.name !== undefined) {
            const [firstName = '', ...rest] = update.name.split(' ')
            await client.users.updateUser(userId, { firstName, lastName: rest.join(' ') })
        }
        if (update.locale !== undefined) {
            await client.users.updateUserMetadata(userId, { publicMetadata: { locale: update.locale } })
        }
        const user = await this.getCurrentUser()
        if (!user) throw new AuthRequiredError()
        return user
    },

    async getMember(orgSlug: string, userId: string): Promise<MemberStanding | null> {
        // The two facts getCurrentUser reads, for a user who is not the caller: the role from the org
        // membership, and `restricted` from the user's metadata and that role (isRestricted). The
        // membership is looked up on the ORG, filtered to this user, so a person in many orgs is never cut
        // off by a page size. No such org, or no membership, means no standing: null, as the port says,
        // never a 404 thrown through to the caller.
        const client = await clerkClient()
        let memberships
        try {
            const organizationId = await organizationIdForSlug(orgSlug)
            memberships = await client.organizations.getOrganizationMembershipList({ organizationId, userId: [userId] })
        } catch (error) {
            if (isClerkAPIResponseError(error) && error.status === 404) return null
            throw error
        }
        // Matched on the user, not taken as the first row: if the filter were ever ignored, the first row
        // would be someone else's membership, and their role.
        const membership = memberships.data.find((m) => m.publicUserData?.userId === userId)
        if (!membership) return null
        const user = await client.users.getUser(userId)
        // A BANNED user has no standing: banning ends their sessions, but their memberships survive it,
        // so without this check their tokens and their email would keep the role. `locked` is
        // deliberately NOT checked: anyone can lock an account by failing its sign-ins, and treating that
        // as "no standing" would hand an attacker a way to kill a victim's tokens.
        if (user.banned) return null
        const metadata = (user.publicMetadata ?? {}) as AppPublicMetadata
        const role = roleFrom(membership.publicMetadata)
        return { role, restricted: isRestricted(metadata.restricted, role) }
    },

    async listMembers(orgSlug: string): Promise<Membership[]> {
        const client = await clerkClient()
        const organizationId = await organizationIdForSlug(orgSlug)
        const [members, invitations] = await Promise.all([
            allPages((page) => client.organizations.getOrganizationMembershipList({ organizationId, ...page })),
            allPages((page) =>
                client.organizations.getOrganizationInvitationList({ organizationId, status: ['pending'], ...page }),
            ),
        ])
        const active: Membership[] = members.map((m) => {
            const data = m.publicUserData
            return {
                // The USER id, never the membership resource id: Membership.id must share
                // AuthUser.id's namespace (notify exclusion, notification recipients, assignee ids
                // all compare the two) — the fake adapter's person ids already do.
                id: data?.userId ?? m.id,
                name: data ? `${data.firstName ?? ''} ${data.lastName ?? ''}`.trim() || null : null,
                email: data?.identifier ?? '',
                role: roleFrom(m.publicMetadata),
                status: 'active' as const,
            }
        })
        const invited: Membership[] = invitations.map((i) => ({
            id: i.id,
            name: null,
            email: i.emailAddress,
            role: roleFrom(i.publicMetadata),
            status: 'invited' as const,
        }))
        return [...active, ...invited]
    },

    /**
     * Clerk's organization invitation. `redirectUrl` sends the invitee to the app's accept page, which reads the
     * `__clerk_ticket` and `__clerk_status` Clerk adds to the URL (./accept-invite-form.tsx); the invitation's own
     * `url` is the link to mail, which Clerk documents as "The URL that the user can use to accept the invitation" and
     * types as nullable. Clerk can also deliver the invitation email itself; which of the two an invitee gets is the
     * `auth-dev` cutover row's to settle.
     *
     * The page goes to Clerk as a PATH, which Clerk's `redirectUrl` accepts ("The full URL or path"), never as the
     * absolute URL it arrives as: that is built from the request's URL, whose host behind `SssbApp` is the server's own
     * (`localhost`), not the app's (.claude/future-tasks/request-url-is-not-the-public-url.md in SSSB's repository).
     */
    async createInvite(invite: InviteInput): Promise<CreatedInvite> {
        const { userId } = await auth()
        if (!userId) throw new AuthRequiredError()
        const client = await clerkClient()
        const organizationId = await organizationIdForSlug(invite.orgSlug)
        const created = await client.organizations.createOrganizationInvitation({
            organizationId,
            emailAddress: invite.email,
            inviterUserId: userId,
            role: 'org:member',
            publicMetadata: { role: invite.role },
            redirectUrl: acceptPagePath(invite.acceptPageUrl),
        })
        return {
            id: created.id,
            name: null,
            email: created.emailAddress,
            role: invite.role,
            status: 'invited',
            acceptUrl: created.url,
        }
    },

    async listMyOrgs(): Promise<OrgRef[]> {
        const { userId } = await auth()
        if (!userId) return []
        const client = await clerkClient()
        const memberships = await allPages((page) => client.users.getOrganizationMembershipList({ userId, ...page }))
        return memberships.map((m) => ({
            slug: m.organization.slug ?? m.organization.id,
            name: m.organization.name,
            role: roleFrom(m.publicMetadata),
        }))
    },

    async setActiveOrg(orgSlug: string): Promise<void> {
        const { userId } = await auth()
        if (!userId) throw new AuthRequiredError()
        const mine = await this.listMyOrgs()
        if (!mine.some((o) => o.slug === orgSlug)) throw new ForbiddenError(`no membership in org: ${orgSlug}`)
        const client = await clerkClient()
        await client.users.updateUserMetadata(userId, { unsafeMetadata: { currentOrgSlug: orgSlug } })
    },
}
