import 'server-only'

import type { AnalyticsPort } from '../ports/analytics'
import type { AuthPort } from '../ports/auth'
import type { DbPort } from '../ports/db'
import type { EmailPort } from '../ports/email'
import type { JobsPort } from '../ports/jobs'
import type { LlmPort } from '../ports/llm'
import type { StoragePort } from '../ports/storage'
import { simulatedDevServer } from './dev-server'
import { fakeAnalytics } from './fake/analytics'
import { fakeAuth } from './fake/auth'
import { fakeDb } from './fake/db'
import { fakeEmail } from './fake/email'
import { fakeJobs } from './fake/jobs'
import { fakeLlm } from './fake/llm'
import { fakeStorage } from './fake/storage'
import { lazyJobs } from './lazy-jobs'
import { appMode, isSimulated } from './run-mode'

/**
 * The adapter registry: the ONE place run mode selects implementations. Simulated is the default —
 * dev, demo, and E2E are first-class citizens on fakes; APP_MODE=real is for adapter work
 * against dev cloud resources and for deployed environments.
 *
 * TWO WORDS, DELIBERATELY. The MODE is `simulated` (is this a simulated world? — what the Simulator
 * panel, the fail-closed guard and every route gate ask). The ADAPTER KIND stays `fake`: in the
 * test-double sense a fake is a working implementation with a shortcut, which is exactly what pglite
 * is for Postgres and `.data/` is for S3. So `if (isSimulated) -> fakeDb` reads correctly: in a
 * simulated world, the DB port is served by a fake.
 *
 * The mode itself is read in ./run-mode.ts, which loads nothing else, so the request proxy (./proxy.ts) can ask it
 * without loading this registry; it is re-exported here, where everything else imports it from.
 */
export { appMode, isSimulated, type AppMode } from './run-mode'

/**
 * Demo build flag. packages/kit/src/adapters is where process.env is read (lint-enforced), so run-mode
 * signals like this live here and everything else imports the boolean — the demo badge, the fail-closed
 * guard below, etc. A demo build is a simulated-mode build that opts in explicitly via DEMO_MODE=1.
 * An app's own adapters (apps/<app>/src/adapters/real) may read their own configuration from process.env,
 * but never these run-mode variables (lint-enforced). The app's registry may not read process.env at all, and
 * takes `isSimulated` from here by convention, which also runs the guard below for it.
 */
export const isDemoMode = process.env['DEMO_MODE'] === '1'

/**
 * E2E build flag. Lets the e2e suite run against a PRODUCTION build instead of `next dev`, which is
 * where most of CI's e2e wall clock goes — every route otherwise pays an on-demand compile, and every
 * timeout in the repo is sized to absorb it.
 *
 * This is deliberately NOT `DEMO_MODE=1`, even though that would already satisfy the guard below.
 * A demo build renders `<DemoBadge />`, which changes the very pages the axe sweep asserts on — the
 * suite would be testing a different product than the one that ships. Measured, not assumed: see
 * `.claude/future-tasks/resolved/e2e-against-production-build.md`.
 */
const isE2eBuild = process.env['E2E_BUILD'] === '1'

/**
 * A developer's own `next dev` of a simulated world, and nothing else (./dev-server.ts says why each condition is
 * there): what a dev-only Simulator affordance asks before it exists. False in real mode, in every production build
 * (deployed, demo, e2e) and under Vitest.
 */
export const isSimulatedDevServer = simulatedDevServer({
    isSimulated,
    nodeEnv: process.env.NODE_ENV,
    isDemoMode,
    isE2eBuild,
})

// Fail CLOSED: a production build must never silently serve fake auth
// because APP_MODE was forgotten. The guard is about ACCIDENTS, so every way past it is an explicit,
// deliberate opt-in: DEMO_MODE=1 for demo builds, E2E_BUILD=1 for a production-build test run.
// Neither can be set by forgetting something. `authorized-mutations.test.ts`'s sibling
// `production-guard.test.ts` proves the guard still closes when no opt-in is set. That no deployed
// environment carries either flag is @sssb/cdk's: the SssbApp construct fails `cdk synth` if the server's
// final environment sets either one or anything but APP_MODE=real.
if (isSimulated && process.env.NODE_ENV === 'production' && !isDemoMode && !isE2eBuild) {
    // The message deliberately does NOT offer the bypasses as remedies. An earlier wording listed all
    // three env vars as ways to proceed, which hands someone debugging a real deployment a menu with
    // two wrong answers on it — and the wrong answers are the ones that make the error stop.
    throw new Error(
        'refusing to run fake adapters in a production build. A deployment must set APP_MODE=real. ' +
            'If you are seeing this in a deployed environment then THAT is the bug: do not set DEMO_MODE ' +
            'or E2E_BUILD to silence it. Those exist only for local demo builds and the e2e suite, and ' +
            'with fake adapters sign-in is passwordless person switching — anyone who reaches the URL ' +
            'is an admin.',
    )
}

// Past the guard with fake adapters in a production build means a bypass is active. That is legitimate
// for a demo build or an e2e run and catastrophic anywhere else, and the two are indistinguishable from
// inside the process — so say so loudly rather than starting quietly. Whoever is reading logs when this
// turns out to be the wrong machine will see it.
if (isSimulated && process.env.NODE_ENV === 'production') {
    const bypass = isDemoMode ? 'DEMO_MODE=1' : 'E2E_BUILD=1'
    console.warn(
        `\n${'!'.repeat(80)}\n` +
            `FAKE ADAPTERS IN A PRODUCTION BUILD — bypass active: ${bypass}\n` +
            `Sign-in is passwordless person switching; there is no real authentication.\n` +
            `This is correct for a demo build or the e2e suite. If this is a real deployment,\n` +
            `stop it now and set APP_MODE=real.\n` +
            `${'!'.repeat(80)}\n`,
    )
}

const real =
    appMode === 'real'
        ? await (await import('./real/index')).createRealPorts({ inProcessJobs: buildInProcessJobs })
        : null

export const auth: AuthPort = real?.auth ?? fakeAuth
export const db: DbPort = real?.db ?? fakeDb
export const storage: StoragePort = real?.storage ?? fakeStorage
export const llm: LlmPort = real?.llm ?? fakeLlm
export const email: EmailPort = real?.email ?? fakeEmail
export const analytics: AnalyticsPort = real?.analytics ?? fakeAnalytics
export const jobs: JobsPort = real?.jobs ?? fakeJobs

/**
 * The in-process job runner (real mode, `JOBS_RUNNER=in-process`), built here rather than by the real ports
 * (./real/index.ts says why), and loaded on its first use (./lazy-jobs.ts): never while this module is evaluated, which
 * would deadlock on a job handler that imports it. Its notification is the jobs webhook route's, with the request
 * path's deps; the notification modules import this registry, so they too are imported when a job ends.
 */
async function buildInProcessJobs(
    ports: Parameters<typeof import('./real/jobs-in-process').createInProcessJobs>[0],
): Promise<JobsPort> {
    return lazyJobs(async () =>
        (await import('./real/jobs-in-process')).createInProcessJobs(ports, notifyJobTerminalFromRegistry),
    )
}

async function notifyJobTerminalFromRegistry(input: {
    tenantId: string
    jobId: string
    status: 'completed' | 'failed'
}): Promise<void> {
    const { notifyJobTerminal } = await import('../server-lib/notify')
    const { makeNotifyDeps } = await import('../server-lib/notify-deps')
    await notifyJobTerminal(await makeNotifyDeps(), auth, input)
}
