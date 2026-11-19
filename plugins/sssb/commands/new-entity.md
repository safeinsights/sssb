---
description: Add a domain entity (subject + RLS table + abilities) through the app-config seam
argument-hint: <entity, and what it is>
---

Add a domain entity for: $ARGUMENTS

**The app** is the directory the workspace root `package.json` lists in `sssb.apps` (with more than one, the one
the request names, or ask). Paths below are relative to that directory; run `pnpm` scripts from the workspace root.
SSSB's reference app is cited by URL, where `<ref>` is the commit your project's Claude Code settings pin the `sssb`
marketplace to (in SSSB's own repository, read its local showcase app instead).

This is the entity core of a slice. Use `/sssb:new-slice` for the full screen-to-e2e flow; use this when the entity
arrives without its own UI (or before it). The app's own `Item` is the worked example throughout, as `pnpm create @sssb`
generated it: its subject in `src/app-config/abilities.ts`, its table in
`src/app-config/db/migrations/1001_items.ts`, its proofs in `src/app-config/db/rls-proofs.ts` and its route in
`src/app/api/items/route.ts`.

1. **Subject + rules**: add the type to `AppSubjectType` and its rules to `appAbilityRules` in
   `src/app-config/abilities.ts`. A subject scoped by two orgs puts the second org's field in `AppSubjectFields`
   (the reference app's `Escalation` is the two-sided example:
   `https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/src/app-config/abilities.ts`). Deny-by-default is
   the framework's; you only add allows. Those rules are for PEOPLE: if a machine caller (a service key, a token
   verifier the app owns) must act on the entity, grant it in `appMachineAbilityRules` too, or every machine gets a 403. Cover the rules in a colocated test (create `src/app-config/abilities.test.ts` if the app has none).
2. **Table**: its interface in `AppTables` (`src/app-config/db/schema.ts`); a migration numbered ≥1001 in
   `src/app-config/db/migrations/`, listed in `src/app-config/db/migrations/index.ts`; copy the RLS pattern of
   `src/app-config/db/migrations/1001_items.ts` (enable RLS + the tenant policy; an app table may reference a
   framework table, never the reverse). Then write the table's section in `src/app-config/db/rls-proofs.ts`, using
   BOTH tenants the proof runner hands that file (`alphaTenantId`, `demoTenantId`): reads isolated both ways under
   unfiltered selects, and a cross-tenant INSERT rejected by `WITH CHECK`. The coverage check only proves the table
   is protected; nothing else proves your proofs cross a tenant boundary
   (`https://github.com/safeinsights/sssb/blob/<ref>/docs/adr/0004-tenancy-rls.md`, addendum of 2026-11-16).
3. **Data access**: create `src/domain/db/<entity>.ts`, and for the pure logic create `src/domain/<entity>.ts` (a
   generated app has `src/domain/db/items.ts` only, the starter's paged list, which is the pattern for a list that grows; the reference app's
   escalations are the pair for the rest:
   `https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/src/domain/db/escalations.ts`
   and `https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/src/domain/escalations.ts`). Tenant-scoped
   queries only inside `db.withTenant()`; `getDb()` is banned (`sssb/no-raw-db-handle`).
4. **Vocabulary**: audit actions in `AppAuditAction` (`src/app-config/audit.ts`); notification and webhook kinds
   with `/sssb:new-notification-kind` and `/sssb:new-webhook-event` if the entity emits them.
5. **Routes** that mutate MUST call `authorize(...)` from `@sssb/kit/authz/authorize` (the conformance suite's
   `authz-mutations` check reads every handler).
6. Finish with `pnpm verify`. You touched a migration, so make sure `pnpm test:contract` ran too (a generated
   workspace's `verify` runs it; SSSB's own repository's does not).
