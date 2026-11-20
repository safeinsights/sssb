# The header's sign-out ends the session on the server only, so a person may still look signed in for a minute

**Priority:** P2 · **Status:** open
**Found by:** review of `fix/auth-fixed-source-followups` (2026-11-20).

## What is true

The user menu's sign-out (`apps/starter/src/app/[locale]/(protected)/header-glue.tsx` and the showcase's) posts to the app's
sign-out route, which calls the auth port's `signOut`. In real mode that is `revokeSession` on Clerk's server
(`packages/kit/src/adapters/real/auth.ts`). The browser keeps Clerk's short-lived session token, which the middleware
verifies locally until it lapses (about a minute by Clerk's default), so the page the glue navigates to can still see
the person signed in. Simulated mode is unaffected: its sign-out deletes the app's own cookie.

The refused-account screen had the same gap and closes it by signing out through Clerk's client
(`packages/kit/src/adapters/real/account-refused-form.tsx`: `useClerk().signOut({ sessionId, redirectUrl })`, gated on
`useAuth().isLoaded`).

## The design

Give the user menu the same real-mode path: a client component in `packages/kit/src/adapters/real/` that renders
`UserMenu` and signs out through Clerk's client, loaded by the app's header with `import()` when `!isSimulated` (as the
sign-in page loads `RealSignInForm`), with its module added to the conformance check `real-auth-provider`'s forms
(`packages/kit/src/testing/conformance/auth-provider.ts`). Keep the server route for simulated mode. Verify against a
real instance under cutover row `auth-dev`.
