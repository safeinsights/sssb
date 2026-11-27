---
'@sssb/kit': minor
'@sssb/create': minor
---

### The authorization check judges read handlers too

**Kind.** seam

**Action.** required

**What changed.** The conformance suite's `authz-mutations` check now judges every exported route handler, GET, HEAD
and OPTIONS as well as POST, PUT, PATCH and DELETE, by the same rules: it reaches `authorize(...)` on its own path, or
its route has an exemption whose gate it passes. A read handler may also pass by reading nothing: every call in it is
to a global (`Response.json`, `new Date`, `fetch`), as a liveness probe's or a CORS preflight's are. Before, a GET that
read org-scoped data without `authorize` passed, and showed a signed-in person with no standing (the role `none`) their
org's rows. The check keeps its id, so an `optOut` naming it still applies; its title and its test's name changed. The
framework exempts one more route, `storage/[...key]/route.ts`, the simulated-mode download twin of
`storage-upload/route.ts`, when it opens with the simulated-mode 404. The SSSB plugin's `/sssb:new-slice` and
`/sssb:new-entity` say so.

**To adopt.** Run the conformance suite (`pnpm test:unit`). For each read handler it names, authorize the read where the
org is known, as the generated app's `src/app/api/items/route.ts` GET does:

```ts
authorize(user, orgId, 'read', { type: 'Item', orgId })
```

A read of the caller's own things authorizes its self-only subject, `authorize(user, user.orgSlug, 'read', { type:
'Notification', ownerId: user.id })` (or `NotificationPref`), and a service route its machine actor,
`authorize(ctx.actor, 'read', { type: 'Job', orgId: ctx.identity.orgId })`. A read that is genuinely not org-scoped (a
public one) names an entry in the app's `authz-exemptions.mjs`, with its reason and a `mustMatch` gate it passes; an
existing entry now also covers a GET at the path it names, which passes its gate, authorizes, or reads nothing.
