import { expect, test } from '@playwright/test'

/**
 * The sign-in page's `returnTo` stays on this origin. A browser reads `/\host` as `//host` and drops a tab
 * anywhere in a URL, so a prefix check ("starts with one slash") would send a signed-in person off-site; each
 * value here must land on the dashboard instead, and a real path on this origin must survive.
 */
const OFF_SITE = ['/\\evil.example', '/\t/evil.example', '//evil.example', 'https://evil.example', '/.//evil.example']

test('a returnTo that would leave the origin lands on the dashboard, signed in or not', async ({ page }) => {
    // Signed out: the picker signs in and goes to the page's normalised target.
    await page.goto(`/en/signin?returnTo=${encodeURIComponent(OFF_SITE[0]!)}`)
    await page.getByTestId('person-person-owner').click()
    await page.waitForURL('**/en/dashboard')

    // Signed in: the page redirects at once.
    for (const value of OFF_SITE) {
        await page.goto(`/en/signin?returnTo=${encodeURIComponent(value)}`)
        await expect(page, value).toHaveURL(/\/en\/dashboard$/)
    }

    // A path on this origin survives, query and fragment included.
    await page.goto(`/en/signin?returnTo=${encodeURIComponent('/en/dashboard?from=signin#top')}`)
    await expect(page).toHaveURL(/\/en\/dashboard\?from=signin#top$/)
})
