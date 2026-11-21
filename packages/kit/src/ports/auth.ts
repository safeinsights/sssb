import type { Locale } from '../core/locale'
import type { Role } from '../core/roles'

export interface AuthUser {
    id: string
    name: string
    email: string
    /** Role in the ACTIVE org (the Clerk org-membership role analog). */
    role: Role
    locale: Locale
    /** Ambient site claim from the deployment/session — never user-switchable in product UI. */
    tenantSlug: string
    /** Slug of the org (product copy: "team") this session is currently acting in. */
    orgSlug: string
    /** Limited-access seam: restricted members see a reduced feature surface. */
    restricted: boolean
}

/**
 * A person's CURRENT standing in one org: what their session would carry if they were the caller. Read
 * for someone who reached the app WITHOUT a session (an inbound email, a personal API token), so their
 * role and `restricted` flag come from the same place a session's do, never from the credential. It also
 * says how to reach them (`name`, `email`), for a notification addressed to one known person, such as the
 * end of a job they started, where no members list names them.
 */
export interface MemberStanding {
    role: Role
    restricted: boolean
    /**
     * How to reach them. SSSB's adapters always say; optional so that a stand-in written before these existed (a
     * test double) still type-checks, and a recipient without an address is told in-app only.
     */
    name?: string | null
    /** The account's primary address, or `''` when it has none. */
    email?: string
}

/** An org the current user belongs to; `role` is their role in THAT org (drives the OrgSwitcher). */
export interface OrgRef {
    slug: string
    name: string
    role: Role
}

export interface Membership {
    /** For an active member, the USER's id (same namespace as AuthUser.id — consumers compare the
     *  two); for a pending invitation, the invitation's id. */
    id: string
    name: string | null
    email: string
    role: Role
    status: 'active' | 'invited'
}

export interface ProfileUpdate {
    name?: string
    locale?: Locale
}

export interface InviteInput {
    email: string
    role: Role
    orgSlug: string
    /**
     * The absolute URL of the app's accept page, with no query (`https://host/en/accept-invite`): where the invitee
     * lands. The adapter builds the link it returns from it, with whatever that page reads to find the invitation.
     */
    acceptPageUrl: string
}

/** A recorded invitation, and the link that lets its invitee accept it. */
export interface CreatedInvite extends Membership {
    /**
     * The link the invitation mail carries, or null when the provider gives none (it delivers the invitation itself).
     * Only the adapter can build it, since only the adapter knows what its accept page reads: the fake's
     * `?invite=<id>`, the provider's own ticket. It is the invitee's credential: mail it to them, and never return it
     * to the inviter.
     */
    acceptUrl: string | null
}

/**
 * Why a person the identity provider has signed in is not a user here. `other-tenant`: their account names another
 * tenant under the deployment's metadata key, or holds there something that is not a slug (a single tenancy's guard),
 * so it is taken to belong to another site.
 */
export interface AuthRefusal {
    reason: 'other-tenant'
}

/**
 * Server-side auth port (ADR-0003). Sized to what the app needs — never to Clerk's API.
 * The custom Mantine auth UI is the ONLY auth UI; both adapters sit behind it.
 */
export interface AuthPort {
    getCurrentUser(): Promise<AuthUser | null>
    /** @throws AuthRequiredError when signed out */
    requireUser(): Promise<AuthUser>
    /** @throws AuthRequiredError | ForbiddenError — roles are evaluated in the ACTIVE org */
    requireRole(...roles: Role[]): Promise<AuthUser>
    /** App-relative path (locale-less) the UI should send signed-out users to. */
    signInPath(returnTo?: string): string
    signOut(): Promise<void>
    updateProfile(update: ProfileUpdate): Promise<AuthUser>
    listMembers(orgSlug: string): Promise<Membership[]>
    /**
     * `userId`'s current standing in `orgSlug`, or null when they have none: not an ACTIVE member of it
     * (never joined, removed, or only invited), or barred from the app altogether. A banned account has
     * no standing; a merely locked one keeps it, since anyone failing its sign-ins can lock it. The caller
     * is `abilityActorFromCredential` (@sssb/kit/authz/authorize), which asks on every call from a person who
     * arrived without a session, so removing a person from an org stops every credential they hold at
     * once.
     */
    getMember(orgSlug: string, userId: string): Promise<MemberStanding | null>
    /**
     * Records the invitation (per-org) and returns the link to accept it; sending the invitation email is the caller's
     * job (email port), with that link.
     */
    createInvite(invite: InviteInput): Promise<CreatedInvite>
    /** Orgs the current user belongs to (drives the OrgSwitcher). */
    listMyOrgs(): Promise<OrgRef[]>
    /** @throws ForbiddenError when the user has no membership in that org */
    setActiveOrg(orgSlug: string): Promise<void>
    /**
     * Why the person signed in to the identity provider on this request is refused here, or null when nobody is
     * signed in or nobody is refused: what tells a refused person apart from a signed-out one, which `getCurrentUser`
     * answers alike (null). Optional: only a port that refuses people has it (a single tenancy's guard). The sign-in
     * page reads it to say why, and to offer an explicit sign-out (`@sssb/kit/components/auth/account-refused`).
     */
    refusal?(): Promise<AuthRefusal | null>
}
