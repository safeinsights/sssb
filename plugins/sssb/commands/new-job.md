---
description: Add a background job kind + handler, registered through the app-config seam
argument-hint: <job kind, and what it does>
---

Add a background job kind for: $ARGUMENTS

**The app** is the directory the workspace root `package.json` lists in `sssb.apps` (with more than one, the one
the request names, or ask). Paths below are relative to that directory; run `pnpm` scripts from the workspace root.
SSSB's reference app is cited by URL, where `<ref>` is the commit your project's Claude Code settings pin the `sssb`
marketplace to (in SSSB's own repository, read its local showcase app instead).

Jobs are the framework's async-execution seam (the port is `@sssb/kit/ports/jobs`; the state machine and statuses
are the framework's). You register the app side, and never edit a framework union:

1. **Handler**: create `src/jobs/<kind>.ts`, a `JobHandler` (`@sssb/kit/ports/jobs`): `(payload, ctx)`, where ctx
   carries the `db`/`storage`/`email`/`llm` ports and the tenant, org (or `null`) and job ids. Follow the reference app's
   `https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/src/jobs/export-tickets.ts`. Result keys must live
   under `exportKeyPrefix(...)` (`@sssb/kit/core/jobs`), the storage-isolation contract; validate payloads
   defensively (they arrive as `unknown`).
2. **Register** in `src/app-config/jobs.ts`: add the kind to `appJobKinds` and the handler to `appJobHandlers`. The
   framework composes `framework ∪ app` for `isJobKind` and the handler map.
3. **Submit path**: a route creates the job with `submitJob` (`@sssb/kit/db/jobs`) over the jobs port, after
   `authorize(user, orgId, 'create', { type: 'Job', orgId })`. A generated app has no jobs route: create
   `src/app/api/jobs/route.ts`, resolving the tenant and team the way `src/app/api/items/route.ts` does. The reference
   app's (`https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/src/app/api/jobs/route.ts`, with its
   dashboard glue for the submit and timeline pattern) is the fuller example; its `resolveOrgContext` is a helper of
   that app's own, which a generated app does not have. Job authorization rides the framework's `Job` subject, so no
   new ability rules unless your kind implies a new entity.
4. **Recurring?** Seed a `job_schedules` row through the app seed's `jobSchedules` (`src/seed/index.ts`); the
   schedules machinery is the framework's and needs no registration.
5. **Colocated test** beside the handler (fake ports; the reference app's
   `https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/src/app-config/jobs.test.ts`): it is what runs
   your handler. On `pnpm dev`, Simulator → Jobs lists the app's jobs and runs what is queued (or, with the world
   clock, what is due), so you can watch a real one there too. The static demo's panel has a Jobs tab, but its jobs are the in-memory world's: a job the
   composition root starts with `world.startJob('<kind>')` walks the status timeline (held while the `jobs-held` flag
   is on) without running your handler. Mirror a new demo surface there, in `src/demo-static/app.tsx`, if the slice
   has one.
6. Finish with `pnpm verify`.
