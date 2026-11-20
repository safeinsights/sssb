# The showcase's `[id]` routes read the row before they authorize, so 403 versus 404 tells a person whether an id exists

**Priority:** P2 · **Status:** open
**Found by:** the auth-tenancy rework (2026-11-20, `feat/auth-tenancy-and-org-source`).

## What is true

The mutating routes under `apps/showcase/src/app/api/*/[id]` fetch the row, answer 404 when it is not there, and only then call `authorize`:

- `apps/showcase/src/app/api/tickets/[id]/route.ts` (PATCH and DELETE: `ticketForOrg`, then `authorize`)
- `apps/showcase/src/app/api/attachments/[id]/confirm/route.ts` (`attachmentForOrg`, then `authorize`)
- `apps/showcase/src/app/api/escalations/[id]/cancel/route.ts` and `…/respond/route.ts` (`escalationForActiveOrg`, then `authorize`)
- `apps/showcase/src/app/api/webhook-endpoints/[id]/route.ts` (its `resolve` helper looks the endpoint up, then `authorize`)

The lookups are already scoped to the caller's tenant and active org, so an id from another org or tenant is a 404, as the routes' own comments say. What remains is inside the active org: a person who may not perform the action (a restricted member trying to delete a ticket, or a person with no standing) gets 403 for an id that exists and 404 for one that does not. Ids are opaque uuids and nothing is returned, so the leak is one bit about existence, and low, but the routes' comments claim ids cannot be probed.

## The design

Make both answers the same, 404:

- authorize against the org first, using only what the caller's session supplies (the org id), and look the row up second, so a person who may not act never reaches the lookup; or
- keep the order, because the real org ids of a two-sided row (escalations) are only known after the fetch, and map the `ForbiddenError` from that authorize to a 404 in the route.

The first suits one-sided subjects (tickets, attachments, webhook endpoints), the second the escalation pair. Either way a person who may act and meets a genuinely missing id still gets 404, and one who may not gets the same body, so say which in the route's comment instead of "ids can't be probed".

Pin it with tests on each route: an existing id and a missing id, for a person who may not act, answer identically (status and body). The tickets route has the pattern to extend in `apps/showcase/src/app/api/tickets/[id]/route.test.ts`.

## Open points

- Whether the starter has the same shape in any `[id]` route it grows; today `apps/starter/src/app/api/items/route.ts` has none.
- A 404 for a person who is plainly allowed to read the list may confuse support: the audit trail should still record the refused attempt.
