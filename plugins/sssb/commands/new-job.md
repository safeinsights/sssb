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
   carries the `db`/`storage`/`email` ports and the tenant, org and job ids. Follow the reference app's
   `https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/src/jobs/export-tickets.ts`. Result keys must live
   under `exportKeyPrefix(...)` (`@sssb/kit/core/jobs`), the storage-isolation contract; validate payloads
   defensively (they arrive as `unknown`).
2. **Register** in `src/app-config/jobs.ts`: add the kind to `appJobKinds` and the handler to `appJobHandlers`. The
   framework composes `framework ∪ app` for `isJobKind` and the handler map.
3. **Submit path**: routes create jobs through the jobs port (the reference app's
   `https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/src/app/api/jobs/route.ts`, and its dashboard
   glue for the submit and timeline pattern). Job authorization rides the framework's `Job` subject, so no new
   ability rules unless your kind implies a new entity.
4. **Recurring?** Seed a `job_schedules` row through the app seed's `jobSchedules` (`src/seed/index.ts`); the
   schedules machinery is the framework's and needs no registration.
5. **Colocated test** beside the handler (fake ports; the reference app's
   `https://github.com/safeinsights/sssb/blob/<ref>/apps/showcase/src/app-config/jobs.test.ts`), then exercise the
   flow in the Simulator's Jobs tab (hold and release with the `jobs-held` flag), and mirror any new demo surface in
   the static demo, `src/demo-static/app.tsx`.
6. Finish with `pnpm verify`.
