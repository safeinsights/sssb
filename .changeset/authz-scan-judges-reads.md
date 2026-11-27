---
'@sssb/kit': minor
'@sssb/create': minor
---

### The authorization check judges read handlers too

**Kind.** seam

**Action.** required

**What changed.** The conformance suite's `authz-mutations` check now judges every exported route handler, GET, HEAD
and OPTIONS as well as POST, PUT, PATCH and DELETE, by the same rules: it reaches `authorize(...)` on its own path, or
its route has an exemption whose gate it passes. A read handler may also pass by reading nothing: it names nothing from
outside itself but inert globals (`Response`, `Date`, `URL`, `JSON`), a `const` bound to a primitive literal (a
string, number, boolean or `null`; not an object or array), `NextResponse` (`next/server`), `redirect`,
`permanentRedirect` and `notFound` (`next/navigation`), and `appMode` and `isSimulated`, as a liveness probe does, or a
CORS preflight whose headers are written inline; one that names `fetch`, `process.env` or any other import authorizes
or names an exemption. Before, a GET that
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

A GET under `src/app/api/webhooks/` that neither authorizes nor reads nothing passes only when it is wrapped by the
webhook guard (`withWebhookSecret` or `withMailgunSignature`), the gate of SSSB's `webhooks/` exemption. An app's own
entry cannot replace that gate, but for one: a provider's verification handshake (a GET that checks a token and
echoes a challenge) that is not wrapped can have a `reads-only` entry for its own file, listing the imports it reads
(see the reads-only gate's entry in these notes). A public read outside `src/app/api` (a feed, a sitemap route) can
have one too, under the exemptions file's `outsideApi` key.
