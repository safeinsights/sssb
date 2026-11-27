import { defineConfig, devices } from '@playwright/test'
import { originFor } from '@sssb/tools/ports'
import { assertNoLiveDevTicker } from '@sssb/tools/ticker-marker'
import { DESTRUCTIVE_EXPECT_TIMEOUT, DESTRUCTIVE_TEST_TIMEOUT, E2E_BUILD } from './tests/e2e/support/budgets'
import { E2E_WORKERS, workerServers, worldOrigin } from './tests/e2e/support/worlds'

// A dev server started with `DEV_TICK_SECONDS` set would be ADOPTED by `reuseExistingServer` below and tick under the
// suite; the ticker leaves a marker while it runs, and this refuses to load past it (@sssb/tools/ticker-marker).
assertNoLiveDevTicker()

// Derived, not literal: a linked worktree under .claude/worktrees/ gets its own port, so a second
// agent session's dev server can never be silently adopted by this one's suite (@sssb/tools/ports).
// The `pnpm dev` below computes the same number from the same function, so the two cannot disagree.
const BASE_URL = originFor('showcase')

/**
 * `E2E_BUILD=1` (CI sets it; local does not) runs against a PRODUCTION build instead of `next dev`
 * (./tests/e2e/support/budgets.ts reads it). A production build removes the on-demand compile that
 * the dev budgets absorb, and it closes a real gap: without it, CI never runs `next build` at all,
 * so a change that breaks the production build ships green.
 *
 * Local stays on dev deliberately: `reuseExistingServer` keeps a warm server across runs, and a
 * build per attempt would cost more than the compiles it saves. The destructive project's budgets
 * are re-derived for the production build (#100); the chromium project's below are still the dev ones.
 */

export default defineConfig({
    testDir: './tests/e2e',
    fullyParallel: true,
    // First hits compile routes on the dev server; give assertions room for cold compiles,
    // and one local retry — parallel first-compiles can transiently fail a page load.
    expect: { timeout: 15_000 },
    // The same reasoning the starter's config already applies to itself, and for the same reason:
    // routes compile on demand, so a test's budget has to cover a compile it did not cause. Playwright's
    // 30s default was survivable only while `workers` was pinned to 1 — measured at 3 workers, the two
    // navigation-heaviest specs (simulator-panel continuity, tenancy) blow through 30s while the dev
    // server serialises their compiles, and fail as bare waitForURL timeouts. Raising the budget does
    // not slow a passing test; it stops a queued compile being reported as a product bug.
    timeout: 60_000,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 1,
    // ONE WORKER BY DEFAULT, AND NOT BECAUSE OF MEMORY. Measured 2026-07-31 on a 10-core/64GB machine, the flake
    // count rose with parallelism over the same 56 tests (workers=1 → 0, 2 → 1, 3 → 2, 4 → 2), with memory to spare:
    // every worker drove ONE server holding ONE `.data`, so specs mutated each other's state.
    //
    // That is what ./tests/e2e/support/worlds.ts ends (safeinsights/sssb#99): on a production build, `E2E_WORKERS=<n>`
    // gives each worker a server and a world of its own, and the suite was green at 2 and 4 workers in every CI run
    // (six of each shard, 2026-11-27). It stays 1 by default because it does not pay on CI, where a pull request waits
    // on lint-typecheck-unit (6 to 10 min) and the e2e shards take under 3 min whatever their worker count; the decision
    // log has the numbers. Under `next dev` it is always 1: Next allows one dev server per app directory.
    workers: E2E_WORKERS,
    reporter: process.env.CI ? 'github' : 'list',
    use: {
        // Each worker's own server (./tests/e2e/support/worlds.ts): BASE_URL itself for worker 0, and with one worker.
        baseURL: worldOrigin(BASE_URL),
        trace: 'on-first-retry',
    },
    projects: [
        // Snapshots' destructive spec wipes .data (reset/restore) — it must not race the fullyParallel
        // main suite's own assumptions (seed people present, specific files/state), so it's a
        // separate project that only starts once every 'chromium' test has finished.
        //
        // The `dependencies` link below orders the two projects for a bare `playwright test`, but it
        // does NOT serialize the destructive specs against EACH OTHER, and all nine of them mutate the
        // same shared world (.data): snapshot resets, mail clears, webhook failure toggles, world-clock
        // jumps. `mode: 'serial'` inside a file only orders that file. In ONE world, destructive spec FILES run in
        // parallel would let one spec's "reset world" pull the floor out from under another's signed-in page
        // (seen on CI when it ran Playwright's default worker count). Playwright has no per-project worker count,
        // so `pnpm test:e2e` runs two passes and pins the destructive one to a single worker (`--no-deps`, since
        // the script already ordered them), as `sssb ci e2e --project destructive` does on CI. With a world per
        // worker (./tests/e2e/support/worlds.ts) that pin could go; it stays while `workers` is 1 by default.
        { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: '**/destructive/**' },
        {
            name: 'destructive',
            use: { ...devices['Desktop Chrome'] },
            testDir: './tests/e2e/destructive',
            dependencies: ['chromium'],
            // Its own budgets, one pair for each server it runs against (./tests/e2e/support/budgets.ts says how each
            // was derived): a production build's, from CI's measured durations, and `next dev`'s, sized for a cold dev
            // server. Because `pnpm test:e2e` runs this as its OWN playwright invocation (see above), and CI sets
            // reuseExistingServer:false, this pass starts against a COLD server, every route of which compiles on its
            // first hit under `next dev`.
            timeout: DESTRUCTIVE_TEST_TIMEOUT,
            expect: { timeout: DESTRUCTIVE_EXPECT_TIMEOUT },
        },
    ],
    webServer: [
        {
            command: E2E_BUILD ? 'pnpm run build:e2e && pnpm run start:e2e' : 'pnpm dev',
            url: BASE_URL,
            // Never reused with more than one world: the servers below serve the build this one makes, so a server adopted
            // here (a dev server, or an earlier run's build) would leave them serving an older one.
            reuseExistingServer: !process.env.CI && E2E_WORKERS === 1,
            // `pnpm dev` ticks the scheduler on a timer when DEV_TICK_SECONDS is set (`sssb dev-tick`). The e2e suite expects a
            // scheduler that does nothing until a test asks, so whatever is in the caller's shell, the server it starts is not ticked.
            env: { DEV_TICK_SECONDS: '' },
            // A production build has to compile before it can serve; dev serves immediately and compiles
            // per-route as tests hit it. Build and start took 26 to 39 s on CI (five runs, 2026-11-27): 180 s is 4.6x that.
            timeout: E2E_BUILD ? 180_000 : 120_000,
        },
        // A server and a world for each further worker, serving the build the one above made.
        ...workerServers(BASE_URL),
    ],
})
