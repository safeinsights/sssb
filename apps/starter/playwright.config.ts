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

export default defineConfig({
    testDir: './tests/e2e',
    fullyParallel: true,
    // This app's whole suite is two short specs, so the first always starts against a cold dev server and pays a
    // full Next compile on every route it touches — sign-in, dashboard, the items route, the Simulator's. The default
    // 30s is marginal for that (it timed out on the first run and passed on retry), and there is no
    // warm-up pass to inherit, so the budget is raised rather than left to flake.
    timeout: 60_000,
    expect: { timeout: 15_000 },
    forbidOnly: !!process.env['CI'],
    retries: process.env['CI'] ? 2 : 1,
    // One worker, on CI too — this app's whole suite is two short specs, so parallelism buys little here,
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
        command: 'pnpm dev',
        url: BASE_URL,
        // `pnpm dev` ticks the scheduler on a timer when DEV_TICK_SECONDS is set (`sssb dev-tick`). The e2e suite expects a
        // scheduler that does nothing until a test asks, so whatever is in the caller's shell, the server it starts is not ticked.
        env: { DEV_TICK_SECONDS: '' },
        reuseExistingServer: !process.env['CI'],
        timeout: 120_000,
    },
})
