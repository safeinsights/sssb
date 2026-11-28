import { defineConfig, devices } from '@playwright/test'
import { originForApp } from '@sssb/tools/ports'
import { assertNoLiveDevTicker } from '@sssb/tools/ticker-marker'

// A dev server started with `DEV_TICK_SECONDS` set would be ADOPTED by `reuseExistingServer` below and tick under the
// suite; the ticker leaves a marker while it runs, and this refuses to load past it (@sssb/tools/ticker-marker).
assertNoLiveDevTicker()

/**
 * A port of this app's own: two apps in one workspace must be able to run (and be tested) side
 * by side without one silently reusing the other's dev server (or a foreign server squatting :3000,
 * which `reuseExistingServer` would otherwise adopt as this app's).
 *
 * Both numbers now come from @sssb/tools/ports rather than being written here, which extends that same
 * guarantee ACROSS checkouts: a linked worktree gets its own pair, so two agent sessions running e2e
 * at once no longer collide either. `pnpm dev` derives the identical number from the same function.
 */
const BASE_URL = originForApp(__dirname)

/**
 * Against a PRODUCTION build instead of `next dev` when `E2E_BUILD=1`, as CI's e2e job sets it (SSSB's reusable
 * workflow). A production build is the stronger check of this app: `next build` typechecks the routes, prerenders what
 * it can and enforces the server/client boundary, all of which `next dev` only meets route by route, when a test happens
 * to reach one. It is also faster on a cold runner, which compiles every route once up front instead of on each first
 * hit. Locally the suite stays on `next dev`, whose warm server `reuseExistingServer` keeps between runs.
 */
const E2E_BUILD = process.env['E2E_BUILD'] === '1'

export default defineConfig({
    testDir: './tests/e2e',
    fullyParallel: true,
    // This app's whole suite is a few short specs, so the first always starts against a cold dev server and pays a
    // full Next compile on every route it touches — sign-in, dashboard, the items route, the Simulator's. The default
    // 30s is marginal for that (it timed out on the first run and passed on retry), and there is no
    // warm-up pass to inherit, so the budget is raised rather than left to flake.
    timeout: E2E_BUILD ? 15_000 : 60_000,
    // On a production build nothing compiles while a test runs, so the budgets only cover the app's own work: measured
    // in five CI runs (2026-11-28), the slowest test took 3.6 s and the slowest assertion 2.3 s, so a test gets 15 s and an
    // assertion 10 s, each over four times that. Under `next dev` they are what they were.
    expect: { timeout: E2E_BUILD ? 10_000 : 15_000 },
    forbidOnly: !!process.env['CI'],
    retries: process.env['CI'] ? 2 : 1,
    // One worker, on CI too — this app's whole suite is a few short specs, so parallelism buys little here,
    // and more workers against one shared world (one `.data` behind one dev server) cost reliability rather than
    // saving time.
    workers: 1,
    reporter: process.env['CI'] ? 'github' : 'list',
    use: {
        baseURL: BASE_URL,
        trace: 'on-first-retry',
    },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
    webServer: {
        command: E2E_BUILD ? 'pnpm run build:e2e && pnpm run start:e2e' : 'pnpm dev',
        url: BASE_URL,
        // `pnpm dev` ticks the scheduler on a timer when DEV_TICK_SECONDS is set (`sssb dev-tick`). The e2e suite expects a
        // scheduler that does nothing until a test asks, so whatever is in the caller's shell, the server it starts is not ticked.
        env: { DEV_TICK_SECONDS: '' },
        reuseExistingServer: !process.env['CI'],
        // A production build compiles the whole app before it serves; `next dev` serves at once and compiles per route.
        // Build and start took 28 s on CI (2026-11-27): 180 s is over 6x that.
        timeout: E2E_BUILD ? 180_000 : 120_000,
    },
})
