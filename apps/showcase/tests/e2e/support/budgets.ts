import { test } from '@playwright/test'

/**
 * The destructive project's time budgets, for the two servers it runs against (safeinsights/sssb#100), in one place
 * that playwright.config.ts and the specs both read.
 *
 * - **A production build** (`E2E_BUILD=1`, CI's e2e job): nothing compiles while a test runs, so a budget only has to
 *   cover the app's own work. Derived from five CI runs of the destructive shard (2026-11-27, PR #233, 80 test runs, no
 *   retry): the slowest test took 16.3 s (`actors.spec.ts`, the autonomous drain, paced by the actors' 3 s timer), the
 *   next 10.9 s. Every wait that took over 2.1 s has a budget of its own in its spec (the measurement kept each test's
 *   four slowest waits), so the default only has to cover the rest. So a test gets 60 s (3.7x the slowest) and an
 *   assertion 10 s (4.7x). A hang now fails in a minute, where it waited two.
 * - **`next dev`** (local, and `pnpm verify`): every route compiles on its first hit, which on a loaded machine has
 *   taken 42 and 52 s for one test's sign-in alone (docs/build-notes.md, "A cold dev server at load ~250"). These
 *   budgets are the ones the suite had before the production build, unchanged: they were sized for a dev server on a
 *   CI runner, and local machines under load come close to that.
 */
export const E2E_BUILD = process.env['E2E_BUILD'] === '1'

export const DESTRUCTIVE_TEST_TIMEOUT = E2E_BUILD ? 60_000 : 120_000
export const DESTRUCTIVE_EXPECT_TIMEOUT = E2E_BUILD ? 10_000 : 15_000

/**
 * The budget for a wait that only `next dev`'s compile makes long, a route's first render after a navigation, say:
 * `ms` on `next dev`, the project's own assertion budget on a production build. A wait for the app's own work (an
 * actor's timer, a world restore, a job draining) keeps a number of its own, which says what it waits for.
 */
export const coldRoute = (ms: number): number => (E2E_BUILD ? DESTRUCTIVE_EXPECT_TIMEOUT : ms)

/** For a test that needs more than the project's budget on `next dev` only: on a production build the budget holds. */
export function slowerOnDev(ms: number): void {
    if (!E2E_BUILD) test.setTimeout(ms)
}
