/**
 * This app's own authorization exemptions, read by SSSB's conformance suite (its `authz-mutations` check): the routes
 * and pages that pass without calling `authorize(...)` because they read nothing org-scoped, each with its reason and
 * the gate it rests on. A `reads-only` gate maps each import such a read may name, besides inert values and SSSB's page
 * allow-list, to the module it must come from; keys under `outsideApi` are relative to `src/app` and matched by URL, so a route group's segment is
 * dropped. The app guide's Authorization section says what an entry may claim (`pnpm exec sssb guide`). A page you add
 * that reads org-scoped data calls `authorize(...)` instead of being named here.
 */
export default {
    outsideApi: {
        files: {
            // The locale layout and the (protected) group's layout share this URL, so this one entry covers both.
            '[locale]/layout.tsx': {
                reason:
                    "The seed's tenants, the instance's own list, not an org's data: the locale layout falls back to the " +
                    "first seeded tenant's theme for a signed-out page (tenants), and the signed-in header names the " +
                    "caller's tenant (findTenant).",
                mustMatch: {
                    kind: 'reads-only',
                    names: { findTenant: 'src/seed/index.ts', tenants: 'src/seed/index.ts' },
                },
            },
            '[locale]/signin/page.tsx': {
                reason:
                    "Signed out by definition. In simulated mode the dev picker lists the simulated world's people " +
                    "(listAllPeople, SSSB's fake auth adapter) with their tenants' names (findTenant, the seed), so a " +
                    "developer can become any of them: the world, not an org. In real mode the provider's form renders " +
                    'instead.',
                mustMatch: {
                    kind: 'reads-only',
                    names: { findTenant: 'src/seed/index.ts', listAllPeople: '@sssb/kit/adapters/fake/auth' },
                },
            },
        },
    },
}
