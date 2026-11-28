/**
 * The showcase's own authorization exemptions, read by SSSB's conformance suite (its `authz-mutations` check,
 * `@sssb/kit/authz/app-exemptions`): the pages that pass without calling `authorize(...)` because they read nothing
 * org-scoped, each with its reason and the gate it rests on. A `reads-only` gate lists the imports the page may name
 * besides inert values and SSSB's page allow-list. Keys under `outsideApi` are relative to `src/app`, matched by URL
 * (a route group's segment is dropped). Every other page of the showcase reads nothing or authorizes
 * (safeinsights/sssb#221).
 */
export default {
    outsideApi: {
        files: {
            // The (protected) group's layout shares this URL; it authorizes, so this entry does not govern it.
            '[locale]/layout.tsx': {
                reason:
                    "The locale layout themes a signed-out page with the default tenant's theme: DEFAULT_TENANT_SLUG is a " +
                    'constant naming that tenant, and a theme is branding, not org data.',
                mustMatch: { kind: 'reads-only', names: ['DEFAULT_TENANT_SLUG'] },
            },
            '[locale]/signin/page.tsx': {
                reason:
                    "Signed out by definition. In simulated mode the dev picker lists the simulated world's people " +
                    "(listAllPeople, the fake auth adapter's world) with their tenants' names (findTenant, the seed), so a " +
                    "developer can become any of them: the world, not an org. In real mode the provider's form renders " +
                    'instead.',
                mustMatch: { kind: 'reads-only', names: ['findTenant', 'listAllPeople'] },
            },
            '[locale]/accept-invite/page.tsx': {
                reason:
                    'Accepting an invite is authorized by possession of its token, before any membership exists (as the ' +
                    "framework's auth/accept-invite/route.ts exemption says). In simulated mode the page resolves the " +
                    "invite the link names (findInvite) and the inviting org's display name (findOrg, the seed), to show " +
                    "what is being accepted; in real mode the provider's ticket form renders instead.",
                mustMatch: { kind: 'reads-only', names: ['findInvite', 'findOrg'] },
            },
            '[locale]/simulator/actors/[actor]/page.tsx': {
                reason:
                    "The Simulator's actor frame, simulated mode only (its first line is notFound() in real mode). " +
                    "isActorId checks the URL's actor id against the seam's list of actors: no data.",
                mustMatch: { kind: 'reads-only', names: ['isActorId'] },
            },
        },
    },
}
