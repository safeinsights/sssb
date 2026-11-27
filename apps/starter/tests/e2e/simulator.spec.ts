import { expect, test, type Page } from '@playwright/test'

/**
 * The Simulator panel on this app's own server: SSSB's panel, fed through `src/app/api/simulator/[...path]/route.ts`.
 * One walk through the tabs it serves (People, Mail, Jobs), with a GET and a POST on each side of a sign-in, and one
 * through Snapshots: a world knob turned, then the world reset to the seed.
 */

/** The pill renders before React attaches its click handler; the panel stamps `data-hydrated` once it has. */
async function openPanel(page: Page) {
    const panel = page.getByTestId('simulator-panel')
    await expect(async () => {
        if (await panel.isVisible()) return
        await page.locator('[data-testid="simulator-pill"][data-hydrated]').click({ timeout: 2_000 })
        await expect(panel).toBeVisible({ timeout: 2_000 })
    }).toPass({ timeout: 30_000 })
}

test('the Simulator signs you in as anyone, and serves its mail and jobs tabs', async ({ page }) => {
    // Signed out: the panel is there anyway, and picking a person signs this browser in as them.
    await page.goto('/en/signin')
    await openPanel(page)
    await page.getByTestId('people-person-other-tenant').click()
    await page.waitForURL('**/dashboard')
    await expect(page.getByTestId('active-tenant')).toHaveText('Westgate')

    // The panel remembers it was open across that reload. It shows the tabs its server serves, and no others.
    await expect(page.getByTestId('simulator-panel')).toBeVisible()
    await expect(page.getByTestId('simulator-tab-mail')).toBeVisible()
    await expect(page.getByTestId('simulator-tab-hooks')).toHaveCount(0)

    await page.getByTestId('simulator-tab-mail').click()
    await expect(page.getByTestId('simulator-mail')).toBeVisible()

    // Running what is due answers with a notice inside the panel.
    await page.getByTestId('simulator-tab-jobs').click()
    await expect(page.getByTestId('simulator-clock-now')).toBeVisible()
    await page.getByTestId('simulator-clock-run-due').click()
    // Its notice, not a new-mail one (which names an address) that happened to arrive at the same moment.
    await expect(page.getByTestId('simulator-notice').filter({ hasNotText: '@' })).toBeVisible()
})

/** Marks this document, so a test can wait for the reload that replaces it even when the URL does not change. */
async function stampDocument(page: Page) {
    await page.evaluate(() => {
        ;(window as unknown as { __beforeReload?: boolean }).__beforeReload = true
    })
}

async function waitForReload(page: Page) {
    await page.waitForFunction(() => !(window as unknown as { __beforeReload?: boolean }).__beforeReload, undefined, {
        timeout: 45_000,
    })
}

test('the Simulator turns a world knob and resets the world to the seed', async ({ page }) => {
    // A reset closes the world's database, and the next request migrates and seeds it again.
    test.setTimeout(120_000)
    // From the seed, so a retry after a failure part-way does not start with the knob already turned.
    expect((await page.request.post('/api/simulator/reset', { data: {} })).ok()).toBe(true)
    await page.goto('/en/signin')
    await openPanel(page)

    // Hold every job at queued: a flag, which reloads the page, since what it changes is server output.
    await page.getByTestId('simulator-tab-snapshots').click()
    await expect(page.getByTestId('simulator-snapshots')).toBeVisible()
    await stampDocument(page)
    await page.getByTestId('flag-toggle-jobs-held').click()
    await waitForReload(page)
    await openPanel(page)
    await page.getByTestId('simulator-tab-jobs').click()
    await expect(page.getByTestId('simulator-jobs-held')).toBeVisible()

    // Reset, a two-step confirm: the page reloads onto the welcome page and the panel says what happened.
    await page.getByTestId('simulator-tab-snapshots').click()
    await stampDocument(page)
    await page.getByTestId('snapshots-reset').click()
    await page.getByTestId('snapshots-reset-confirm').click()
    await waitForReload(page)
    await openPanel(page)
    await expect(page.getByTestId('simulator-notice').filter({ hasNotText: '@' })).toBeVisible()

    // The knob is back where the seed has it.
    await page.getByTestId('simulator-tab-jobs').click()
    await expect(page.getByTestId('simulator-clock-now')).toBeVisible()
    await expect(page.getByTestId('simulator-jobs-held')).toHaveCount(0)
})
