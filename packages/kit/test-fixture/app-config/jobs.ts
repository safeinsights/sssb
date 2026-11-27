import { digestEmailHandler } from '@sssb/kit/jobs/digest-email'
import type { JobNotify, JobRetry } from '@sssb/kit/core/jobs'
import type { JobHandler } from '@sssb/kit/ports/jobs'
import { exportDocketsHandler } from '../domain/export-dockets'
import { flakyDocketsHandler } from '../domain/flaky-dockets'
import { noopDocketsHandler } from '../domain/noop-dockets'

/**
 * The APP's job registrations (the seam side of @sssb/kit/core/jobs.ts, ADR-0012).
 *
 * THREE app kinds, one for each value of `jobNotify` (below): `export-dockets` says nothing, so it takes the
 * default, `always`; `sweep-dockets` is `failure`; `quiet-dockets` is `never`. @sssb/kit/server-lib/notify.ts builds
 * NOTIFIED_JOB_KINDS out of `appJobKinds`, so `server-lib/notify.test.ts` needs an app kind that notifies AND the
 * framework's own `digest-email` that does not — a distinction an empty registration cannot express — and
 * `server-lib/notify-opt-out.test.ts` needs all three modes, each run on every runner. A FOURTH, `flaky-dockets`, is the
 * one kind with a `jobRetry` entry (below), for the retry proofs (`db/job-retries.test.ts`).
 *
 * COMPOSITION ROOT: `jobHandlers` is the single dispatch map the fake jobs adapter consumes. The
 * framework reaches its OWN handler through this seam because the fence forbids the adapter importing
 * app-side modules directly.
 */
export const appJobKinds = ['export-dockets', 'sweep-dockets', 'quiet-dockets', 'flaky-dockets'] as const
export type AppJobKind = (typeof appJobKinds)[number]

/**
 * One handler per app job kind, exhaustive over AppJobKind — the map that makes "every registered kind
 * has a handler" a compile-time fact. Deliberately NOT exported: nothing outside this module reads it
 * (SSSB imports only `jobHandlers` and `serviceManagedOrgSlugs` from here), and an export with no
 * consumer is dead code the gate flags. A real app exports it because its own tests assert on it.
 */
const appJobHandlers: Record<AppJobKind, JobHandler> = {
    'export-dockets': exportDocketsHandler,
    'sweep-dockets': noopDocketsHandler,
    'quiet-dockets': noopDocketsHandler,
    'flaky-dockets': flakyDocketsHandler,
}

/**
 * When each app kind's terminal state notifies the team's admins (`always` | `failure` | `never`). A kind this
 * leaves out is `always`, which is what every kind did before this export existed, so `export-dockets` states nothing.
 * The export is optional: an app that never says is unchanged.
 */
export const jobNotify: Partial<Record<AppJobKind, JobNotify>> = {
    'sweep-dockets': 'failure',
    'quiet-dockets': 'never',
}

/**
 * How each app kind is tried again after it fails (safeinsights/sssb#135). Only `flaky-dockets` retries: three attempts,
 * one minute and then ten minutes apart. A kind this leaves out runs once; the export is optional.
 */
export const jobRetry: Partial<Record<AppJobKind, JobRetry>> = {
    'flaky-dockets': { attempts: 3, delaysMs: [60_000, 600_000] },
}

/** The composed dispatch map (framework kinds + app kinds) — the jobs adapter's single source. */
export const jobHandlers: Record<string, JobHandler> = {
    'digest-email': digestEmailHandler,
    ...appJobHandlers,
}

/**
 * Org slugs whose jobs are served by a dedicated service actor, and are therefore EXCLUDED from the
 * generic pending-build pool (@sssb/kit/adapters/fake/jobs.ts listPendingBuilds).
 *
 * NON-EMPTY on purpose: `adapters/fake/jobs.test.ts` proves the pool excludes service-managed orgs, and
 * with an empty list that assertion would pass vacuously. `depot` is the fixture's primary org, so the
 * exclusion is visible against jobs the same test submits into its sibling and the other tenant.
 */
export const serviceManagedOrgSlugs: readonly string[] = ['depot']
