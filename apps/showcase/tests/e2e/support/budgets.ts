import { test } from '@playwright/test'

/**
 * The suite's time budgets, for the two servers it runs against, in one place that playwright.config.ts and the specs
 * both read.
 *
 * - **A production build** (`E2E_BUILD=1`, CI's e2e job): nothing compiles while a test runs, so a budget only has to
 *   cover the app's own work. Each number is at least three times the slowest the CI runs below saw.
 *   - The `destructive` project (safeinsights/sssb#100; five runs, 2026-11-27, PR #233, 80 test runs, no retry): the
 *     slowest test took 16.3 s (`actors.spec.ts`, the autonomous drain, paced by the actors' 3 s timer), the next
 *     10.9 s. A test gets 60 s (3.7x).
 *   - The `chromium` project (safeinsights/sssb#235; five runs, 2026-11-28, PR #272, 300 test runs, no retry): the slowest
 *     test took 5.7 s (`simulator-mail.spec.ts`), the next 4.8 s. A test gets 20 s (3.5x).
 *   - An assertion, in both: 10 s. The slowest one left on the default budget took 2.3 s (a tour resuming after a preset
 *     load, through `coldRoute`), 4.3x under it; every slower one waits for the app's own work and has a budget of its
 *     own in its spec. An action (a click, a navigation) is bounded by its test's budget: the slowest took 6.1 s.
 *   A hang now fails in 20 s or a minute, where it waited one or two.
 * - **`next dev`** (local, and `pnpm verify`): every route compiles on its first hit, which on a loaded machine has
 *   taken 42 and 52 s for one test's sign-in alone (docs/build-notes.md, "A cold dev server at load ~250"). These
 *   budgets are the ones the suite had before the production build, unchanged: they were sized for a dev server on a
 *   CI runner, and local machines under load come close to that.
 */
export const E2E_BUILD = process.env['E2E_BUILD'] === '1'

export const CHROMIUM_TEST_TIMEOUT = E2E_BUILD ? 20_000 : 60_000
export const DESTRUCTIVE_TEST_TIMEOUT = E2E_BUILD ? 60_000 : 120_000
export const EXPECT_TIMEOUT = E2E_BUILD ? 10_000 : 15_000

/**
 * The budget for a wait that `next dev`'s compile makes long: the first render after a navigation or a reload (the
 * tour specs' resume after a snapshot restore or a preset load is one: at most 2.3 s on a production build), or a page's
 * hydration before a click can land. `ms` on `next dev`, the assertion budget on a production build. A wait that is
 * long for the app's own work on any server (an actor's timer and its backoff, a preset's replay, a job draining, an
 * email arriving) keeps a number of its own.
 */
export const coldRoute = (ms: number): number => (E2E_BUILD ? EXPECT_TIMEOUT : ms)

/** For a test that needs more than the project's budget on `next dev` only: on a production build the budget holds. */
export function slowerOnDev(ms: number): void {
    if (!E2E_BUILD) test.setTimeout(ms)
}
