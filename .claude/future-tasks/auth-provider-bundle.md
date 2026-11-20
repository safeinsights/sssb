# Auth as a provider bundle, so an identity provider other than Clerk can stand behind the port

**Priority:** P3 · **Status:** open, recorded design; build when an adopter needs a provider other than Clerk
**Decided in:** ADR-0015, the Auth0 worked example and both addenda (2026-11-19). Related: `named-adapters.md` (the
mechanism a bundle registers through) and `self-service-auth-mfa-and-invitations.md` (the auth surface still missing).

## Why

The fake auth adapter and SSSB's auth screens use no Clerk code, so the port is a real seam. But in real mode an
auth adapter is more than its server methods, and those other pieces name Clerk today:

- `withAuthProxy` imports `./real/clerk-proxy` by name;
- `createRealPorts` imports `realAuth` statically, and hands it to the in-process job runner;
- `CLERK_*` is required by every real deployment;
- the app's route files load SSSB's Clerk forms and provider by path;
- the conformance check `real-auth-provider` names those paths.

## The shape, decided

A bundle: the server port, the request middleware, the client provider, the sign-in and invite-acceptance bodies, the
invitation link (which `createInvite` already returns, since safeinsights/sssb#83), and its settings. The kit gains
entry points that dispatch on `AUTH_PROVIDER` (the provider, the sign-in body, the accept body), which app route files
load instead of Clerk's modules, and the conformance check holds apps to those entry points. Clerk becomes SSSB's real
bundle with no change in behaviour. The port changes that most hosted or OIDC providers need: sign-in as a step that
may redirect, and `signOut` returning where the browser goes next.

## Options to weigh when it is built

- An OIDC bundle in the kit, as a protocol choice (identity only; membership stays a vendor's management API).
- Membership, roles and invitations in SSSB's own tables, leaving the provider only the credential.

## Done when

- Clerk is a bundle behind the entry points with every gate green.
- A second bundle, the adopter's provider or OIDC, signs in, accepts an invite and signs out, in its own contract suite
  against a dev tenant.
- ADR-0003 has its addendum: the credential step may be a provider-hosted page in real mode.
