# The authorization scan judges only mutating verbs, so a GET that reads org-scoped data is held to "authorize the read" by the guide alone

**Priority:** P1 · **Status:** open
**Found by:** the single-tenant auth work (`feat/auth-single-tenant`, 2026-11-19), which added `authorize(…, 'read', …)` to every org-scoped GET of both reference apps; recorded by the auth-tenancy rework (2026-11-20, `feat/auth-tenancy-and-org-source`).

## What is true

The app guide (`packages/kit/src/guide.md`, Authorization) says a route or screen that reads org-scoped data authorizes the read too: the session's org says where a person is placed, not that they may read there, and the role `none` is placed in an org with no standing in it. Nothing enforces it. The scan (`packages/kit/src/authz/route-scan.ts`, `MUTATING_VERBS`) judges POST, PUT, PATCH and DELETE only, GET, HEAD and OPTIONS are never judged, and the conformance check `authz-mutations` (applied per app by `packages/kit/src/authz/app-exemptions.ts`) inherits that. A new org-scoped GET that forgets `authorize` passes every gate and shows a person with no standing their org's rows.

Today the reference apps' reads are pinned only by hand-written route tests, one per route (a restricted member reads, and `none` is refused); an app's own routes have nothing.

## The design

Extend the scan to a GET handler that resolves an org, and require an `authorize(…, 'read', …)` call that the same reachability rules accept (awaited, not in a swallowing `try`, the real function by binding). Pick the trigger by what a handler does, never by its path:

- it calls `orgIdForSlug` or the app's `resolveOrgContext`, or
- it makes a tenant-scoped db call (`db.withTenant`, or a helper that does) with an org id argument.

A GET with neither is not org-scoped and stays unjudged.

Exemptions reuse the existing map (`reason` plus a `mustMatch` gate), keyed the same way. The ones to expect are self-only routes (a person's own notifications or preferences, authorized by ownership, not by org), health and readiness probes, and the simulated-mode 404 routes.

## False positives to weigh before building

- A helper in another module that resolves the org and authorizes inside it: the existing "authorize in a helper" rules apply, but a helper that resolves AND authorizes, called from the handler, needs the scan to follow it the way it follows one for a mutation.
- Tenant-only reads (no org id) are not org-scoped: do not flag them, or every recipient-scoped list needs an exemption.
- A GET that authorizes a different action (a read that is really an `update` check) satisfies "an authorize call" but not "a read": decide whether the scan requires the action to be `read`, or only any `authorize` call as for a mutation. The first catches more and false-positives on a legitimate `manage`.
- The fixture's reference tree (`packages/kit/test-fixture/api`) needs a GET that demonstrates each exemption, because the framework map's staleness is measured against it.

## Done when

An org-scoped GET with no `authorize` fails `authz-mutations` in both apps (seen failing before it is trusted), the fixture proves the exemptions, and the guide's sentence says the scan enforces it, with a changeset.
