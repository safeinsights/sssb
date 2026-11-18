---
description: Start a vertical feature slice (screen + route + port usage + tests) the house way
argument-hint: <the feature>
---

Plan and build a vertical slice for: $ARGUMENTS

**The app** is the directory the workspace root `package.json` lists in `sssb.apps` (with more than one, the one
the request names, or ask). Paths below are relative to that directory; run `pnpm` scripts from the workspace root.
SSSB's reference app is cited by URL, where `<ref>` is the commit your project's Claude Code settings pin the `sssb`
marketplace to (in SSSB's own repository, read its local showcase app instead).

A slice is APP code. It registers new entities through the `src/app-config/` seam and imports the framework freely;
the framework reaches your app only through the `@sssb/app-config/*` alias, so you never edit a framework union or
switch to add a subject, kind or table: you register it. The app's own Items slice is the end-to-end example, as the
starter generated it: `src/components/items-card.tsx`, `src/app/api/items/route.ts`,
`src/app/[locale]/(protected)/dashboard/dashboard-glue.tsx`, and its seam registrations below. The reference app's
tickets are the same shape at more size
(`https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/src/components/tickets-card.tsx`).

House shape for a slice:

1. **Router-agnostic screen** in `src/components` (props in, async callbacks out). No hard-coded strings: every
   literal goes through next-intl. Reuse an entry of `APP_NAMESPACES` (`src/app-config/messages.ts`) or register a
   NEW namespace there, then add its keys to BOTH `messages/en.json` and `messages/es.json` (the catalogs stay key-
   and placeholder-identical, and the framework/app namespace partition is checked by the conformance suite).
2. **Route handler(s)** under `src/app/api/`, using ports only; tenant-scoped data through `db.withTenant()` (never
   `getDb()`: `sssb/no-raw-db-handle` bans it under `src`); auth through `auth.requireUser()`/`requireRole()`. Every
   mutating route (POST/PUT/PATCH/DELETE) MUST call `authorize(...)` (`@sssb/kit/authz/authorize`): the conformance
   suite's `authz-mutations` check fails any route that neither calls it nor is justified in the app's exemption map.
3. **Authorization**: register your subject types and rules on the seam: `AppSubjectType`, `appAbilityRules` (and
   any two-sided fields in `AppSubjectFields`) in `src/app-config/abilities.ts`, following the `Item` case.
   Deny-by-default is the framework's; you only add rules. A route a MACHINE calls passes its machine actor
   (`authorize(actor, action, subject)`), and the grant goes in `appMachineAbilityRules`, never in an exemption.
4. **New table**: its interface in `AppTables` (`src/app-config/db/schema.ts`; the framework's `DB` type
   `extends AppTables`, so `import type { DB }` keeps working), and a migration numbered ≥1001 under
   `src/app-config/db/migrations/`, listed in `src/app-config/db/migrations/index.ts`. Copy the RLS pattern of
   `src/app-config/db/migrations/1001_items.ts` (enable RLS + the tenant policy). Add the table's section to
   `src/app-config/db/rls-proofs.ts`, using BOTH tenants its runner hands it (`alphaTenantId`, `demoTenantId`):
   isolated reads both ways and a cross-tenant INSERT rejected by `WITH CHECK`. Run it under BOTH `pnpm test:unit`
   and `pnpm test:contract` (the same proofs on real Postgres). A list that can grow pages through
   `@sssb/kit/db/keyset`.
5. **App vocabulary** registers through the matching seam module, never a framework union: job kinds and handlers
   in `src/app-config/jobs.ts`, notification kinds, payloads and copy in `src/app-config/notifications.ts`,
   outbound webhook event kinds in `src/app-config/webhooks.ts`, inbound-email handlers in
   `src/app-config/inbound-email.ts`, a Simulator tab or Snapshots flag in `src/app-config/simulator.ts`. The
   framework composes each as `framework ∪ app`.
6. **Thin page + client glue** under `src/app/[locale]/` (the glue owns fetching and polling; the screen stays
   router-agnostic). Ship the static-demo twin in `src/demo-static/app.tsx` too if the slice adds a Simulator or
   demo-world surface: the `file://` build has no server, and the static demo keeps parity with `pnpm dev`.
7. **Tests**: a Playwright e2e for the user-visible flow (`tests/e2e/`, like `tests/e2e/items.spec.ts`).
8. **Finish with `pnpm verify`** (and make sure `pnpm test:contract` ran when you touched a migration). Work on a
   branch; conventional commits; run `/sssb:pre-pr` before opening the PR.
