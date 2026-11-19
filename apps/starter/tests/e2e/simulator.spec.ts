import { expect, test, type Page } from '@playwright/test'

/**
 * The Simulator panel on this app's own server: SSSB's panel, fed through `src/app/api/simulator/[...path]/route.ts`.
 * One walk through the tabs it serves (People, Mail, Jobs), with a GET and a POST on each side of a sign-in.
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

    // Running what is due leaves the clock where it is and says what happened.
    await page.getByTestId('simulator-tab-jobs').click()
    await expect(page.getByTestId('simulator-clock-now')).toBeVisible()
    await page.getByTestId('simulator-clock-run-due').click()
    await expect(page.getByTestId('simulator-notice').first()).toBeVisible()
})
