# A person refused by the single-tenant guard is not signed out of the identity provider

**Priority:** P2 · **Status:** resolved (2026-11-20, `fix/auth-fixed-source-followups`)
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

## Resolution (2026-11-20, `fix/auth-fixed-source-followups`)

Built on the sign-in page rather than a page of its own: a refused person is sent to sign in by every protected page
already (`getCurrentUser` answers null), so that is where they land.

- **The guard reports its refusal**: the auth port gains an optional `refusal()` (`packages/kit/src/ports/auth.ts`),
  which the configured port answers (`packages/kit/src/adapters/configured-auth.ts`) with `{ reason: 'other-tenant' }`
  for a signed-in account its guard refuses, and null otherwise. It is read on the sign-in page only, not per request.
- **The framework's screen** `AccountRefused` (`@sssb/kit/components/auth/account-refused`) says the account belongs
  to another site, says before anyone clicks that signing out also signs them out of other sites sharing the sign-in,
  and offers one sign-out button. Router-agnostic: in simulated mode the app's glue posts JSON to its own sign-out route
  and reloads; in real mode `RealAccountRefused` (`@sssb/kit/adapters/real/account-refused-form`) signs out through
  Clerk's client, since the server-side revocation alone leaves the browser's short-lived session token. Its copy is
  in both locales of the framework's catalog; a story sits with the other auth stories.
- **Both reference apps' sign-in pages** check `auth.refusal?.()` after `getCurrentUser` and show the screen instead of
  the sign-in form or the picker. This also covers simulated mode: under a single tenancy the picker can sign in a
  seeded person of another tenant, who now sees the same screen and signs out through the fake.
- **Never automatic**: the sign-out is the person's click, through Clerk's client in real mode and the app's sign-out
  route in simulated mode. Rejected:
  signing out from `getCurrentUser` (a cookie change during render, which Next refuses), and a page of its own reached
  from the protected layout, which would need the layout to read the refusal on every request.
