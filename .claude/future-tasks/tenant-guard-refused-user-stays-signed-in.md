# A person refused by the single-tenant guard is not signed out of the identity provider

**Priority:** P2 · **Status:** open
**Found by:** the auth-tenancy rework (2026-11-20, `feat/auth-tenancy-and-org-source`).

## What is true

Under single tenancy (`AUTH_TENANCY=single`, `packages/kit/src/adapters/auth-tenancy.ts`), a person whose identity-provider metadata names a different tenant is refused: the guard in `packages/kit/src/adapters/configured-auth.ts` makes `getCurrentUser` return null. They are not signed out of the provider. They see the sign-in screen again while still signed in there, so signing in as the same account loops, and the only way out is to sign out of the provider by some other route.

Signing out inside `getCurrentUser` is not an option: it changes a cookie while a server component renders, which Next refuses. And it would be wrong on a provider instance shared with another product, where it would end the person's session there too. Leaving the session alone is deliberate; the missing piece is telling the person why and giving them the choice.

## The design

A dedicated refusal page, reached from the protected layout when the guard refuses a person who does have a provider session:

- the guard reports a distinct refusal (not the same null as "nobody signed in"), so the layout can tell the two apart without a second provider call;
- the page says, in the catalog, that this account belongs to another site, and offers one explicit sign-out button (a route handler or action, where changing a cookie is allowed), then returns to the sign-in screen;
- the page is router-agnostic like the other framework screens (`packages/kit/src/components`), with its messages in both locales of the framework's catalog, and a story beside the others.

Keep the sign-out explicit and per click: never make it automatic, for the shared-instance reason above.

## Open points

- Whether the refusal page belongs to the framework's screens or to each app's protected layout. The framework's, if the guard is the framework's.
- The static demo and simulated mode have no provider session: the page needs a simulated path or none at all.
