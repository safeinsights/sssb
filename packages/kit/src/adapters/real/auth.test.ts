import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Clerk adapter's invitation, with Clerk's server SDK replaced: what it asks Clerk for and what it hands back. The
 * adapter has never run against a real Clerk instance (cutover row `auth-dev`), so this pins its side of the contract:
 * Clerk is told to send the invitee to the app's accept page, and the link returned for the invitation mail is
 * Clerk's own invitation URL, which carries the ticket that page reads.
 */
const h = vi.hoisted(() => ({
    created: [] as Record<string, unknown>[],
    url: 'https://accounts.example.clerk/v1/tickets/accept?ticket=t-1' as string | null,
}))

vi.mock('@clerk/nextjs/server', () => ({
    auth: async () => ({ userId: 'user_inviter' }),
    currentUser: async () => null,
    clerkClient: async () => ({
        organizations: {
            getOrganization: async ({ slug }: { slug: string }) => ({ id: `org_${slug}` }),
            createOrganizationInvitation: async (params: Record<string, unknown>) => {
                h.created.push(params)
                return { id: 'orginv_1', emailAddress: params['emailAddress'], url: h.url }
            },
        },
    }),
}))
vi.mock('@clerk/nextjs/errors', () => ({ isClerkAPIResponseError: () => false }))

beforeEach(() => {
    h.created.length = 0
    h.url = 'https://accounts.example.clerk/v1/tickets/accept?ticket=t-1'
})

const INVITE = {
    email: 'invitee@example.test',
    role: 'member' as const,
    orgSlug: 'depot',
    acceptPageUrl: 'https://app.example.test/en/accept-invite',
}

describe('the Clerk adapter, inviting', () => {
    it("sends the invitee to the app's accept page and returns Clerk's invitation URL as the link", async () => {
        const { realAuth } = await import('./auth')
        const invite = await realAuth.createInvite(INVITE)
        expect(h.created).toEqual([
            expect.objectContaining({
                organizationId: 'org_depot',
                emailAddress: 'invitee@example.test',
                inviterUserId: 'user_inviter',
                redirectUrl: 'https://app.example.test/en/accept-invite',
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
