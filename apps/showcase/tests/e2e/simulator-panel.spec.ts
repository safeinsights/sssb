import { rmSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { simulatorNotice } from '../catalog'
import { openSimulatorPanel } from './support/simulator'
import { pickOrg } from './support/org-switcher'
import { signInAs } from './support/people'
import { worldPath } from './support/worlds'

function clearSimulatorState() {
    try {
        rmSync(worldPath('simulator', 'state.json'))
    } catch {
        // never existed / already gone — fine
    }
}

// Simulator continuity (lastPath, remembered active org) persists to a shared .data file, so a
// remembered org/route from THIS spec must not leak into other spec files, and stale lastPath values
// from earlier spec files (e.g. auth-flows.spec.ts leaving person-staff on /en/profile) must not
// make this spec's own redirect assertions flaky. Clear on both sides of the suite.
test.beforeAll(clearSimulatorState)
test.afterAll(clearSimulatorState)

test('simulator is gated by mode, not role: the lowest-privilege person still sees it', async ({ page }) => {
    // This deliberately inverts the old dev-tools assumption (manager-only): switching TO a
    // low-privilege person must never strand you, so Simulator renders for everyone.
    await signInAs(page, 'person-restricted')
    await expect(page.getByTestId('simulator-pill')).toBeVisible()

    await openSimulatorPanel(page)
    await expect(page.getByTestId('people-person-restricted')).toBeVisible()
})

test('people rows show every org membership, each with its own role', async ({ page }) => {
    // Sam is staff on the desk and a plain member on the platform team — a single role chip (the old
    // memberships[0]) misstated the second membership and hid that it existed at all.
    await signInAs(page, 'person-member')
    await openSimulatorPanel(page)
    await expect(page.getByTestId('org-chip-person-staff-frontline')).toHaveText('frontline · staff')
    await expect(page.getByTestId('org-chip-person-staff-platform')).toHaveText('platform · member')
})

test('continuity round-trip: switching people and back restores route and active org', async ({ page }) => {
    await signInAs(page, 'person-admin')

    // put Dana somewhere memorable, in a non-default org, before switching away
    await page.goto('/en/org')
    await expect(page.getByTestId('member-table')).toBeVisible()
    await pickOrg(page, 'platform')
    // the OrgScreen title is the active org's name — a direct read of "which org am I in"
    await expect(page.getByRole('heading', { name: 'Platform Team' })).toBeVisible()

    await openSimulatorPanel(page)
    await page.getByTestId('people-person-staff').click()

    // a full reload is expected (theme + header are per-user RSC output) — wait for the URL
    // rather than racing the client nav (see docs/build-tickets.md on glue-triggered reloads)
    await page.waitForURL('**/dashboard')
    await expect(page.getByTestId('signed-in-as')).toContainText('Sam Rivera')

    // the panel's own "expanded" flag is in localStorage, so it survives that reload — no need
    // to click the pill again
    await expect(page.getByTestId('simulator-panel')).toBeVisible()
    await page.getByTestId('people-person-admin').click()

    await page.waitForURL('**/org')
    await expect(page.getByTestId('member-table')).toBeVisible()
    // Dana is restored to her remembered org (platform), not reset to her first membership
    await expect(page.getByRole('heading', { name: 'Platform Team' })).toBeVisible()
})

test('signed-out: the pill still renders on the sign-in page, and picking a person signs you in', async ({ page }) => {
    await page.goto('/en/signin')
    await expect(page.getByTestId('simulator-pill')).toBeVisible()

    await openSimulatorPanel(page)
    await page.getByTestId('people-person-guest').click()

    await page.waitForURL('**/dashboard')
    await expect(page.getByTestId('signed-in-as')).toContainText('Gale Bennett')
})

test('opening and hiding the panel by keyboard moves focus to the control that replaces the one pressed', async ({
    page,
}) => {
    // WCAG 2.4.3: the pill unmounts when the panel opens and Hide is hidden with it, so without the focus effect in
    // simulator-panel.tsx both presses leave focus on <body> and the next Tab starts from the top of the page.
    await page.goto('/en/signin')
    const pill = page.locator('[data-testid="simulator-pill"][data-hydrated]')
    const hide = page.getByTestId('simulator-collapse')

    await pill.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('simulator-panel')).toBeVisible()
    await expect(hide).toBeFocused()

    // A panel restored open from localStorage on load must not take focus: only a toggle moves it.
    await page.reload()
    await expect(page.locator('[data-testid="simulator-panel"][data-hydrated]')).toBeVisible()
    await expect(hide).not.toBeFocused()

    await hide.focus()
    await page.keyboard.press('Enter')
    await expect(pill).toBeFocused()
})

test('the dev ticker control is on a dev server only, stopped until started, and absent from the e2e build', async ({
    page,
}) => {
    // CI runs this suite against the E2E_BUILD production build, where the route answers 404 and the Jobs tab has no
    // control; a local run uses `pnpm dev`, where the control is there and stopped. Nothing here starts it: the suite
    // expects a scheduler that does nothing until a test asks (@sssb/tools/ticker-marker).
    const e2eBuild = process.env.E2E_BUILD === '1'
    await page.goto('/en/signin')
    await openSimulatorPanel(page)
    const asked = page.waitForResponse(
        (response) =>
            new URL(response.url()).pathname === '/api/simulator/ticker' && response.request().method() === 'GET',
    )
    await page.getByTestId('simulator-tab-jobs').click()
    expect((await asked).status()).toBe(e2eBuild ? 404 : 200)

    await expect(page.getByTestId('simulator-clock')).toBeVisible()
    if (e2eBuild) {
        await expect(page.getByTestId('simulator-ticker')).toHaveCount(0)
    } else {
        await expect(page.getByTestId('simulator-ticker-status')).toHaveText(simulatorNotice('en', 'tickerStopped', ''))
        await expect(page.getByTestId('simulator-ticker-toggle')).toHaveText(simulatorNotice('en', 'tickerStart', ''))
    }
})
