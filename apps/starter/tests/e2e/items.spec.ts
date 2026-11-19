import { expect, test, type Page } from '@playwright/test'

/**
 * This app's whole e2e budget, spent on the one claim this app exists to prove: an item written
 * in one tenant is invisible from the other, through the entire stack (UI → route → withTenant → RLS
 * on pglite).
 *
 * This app has no Simulator panel, so crossing tenants is done the way a real user would — sign out,
 * sign in as somebody whose home tenant differs.
 */

async function signInAs(page: Page, personId: string) {
    await page.goto('/en/signin')
    await page.getByTestId(`person-${personId}`).click()
    await page.waitForURL('**/dashboard')
}

async function signOut(page: Page) {
    await page.getByTestId('user-menu').click()
    await page.getByTestId('menu-signout').click()
    await page.waitForURL(/\/en\/?$/)
}

/** Hydration-safe entry: right after a navigation, filling the controlled input can beat React
 *  hydration, so the DOM has the text but state does not and the button stays disabled. */
async function addItem(page: Page, title: string) {
    await expect(async () => {
        await page.getByTestId('item-input').fill(title)
        await expect(page.getByTestId('item-add')).toBeEnabled({ timeout: 1_000 })
    }).toPass()
    await page.getByTestId('item-add').click()
    await expect(page.getByTestId('items-list')).toContainText(title)
}

test('an item created in one tenant is invisible from the other', async ({ page }) => {
    const secret = `northwind-item-${Date.now()}`

    // Nadia's home tenant is northwind.
    await signInAs(page, 'person-owner')
    await expect(page.getByTestId('active-tenant')).toHaveText('Northwind')
    await addItem(page, secret)

    // Reload proves the row survived a round trip through Postgres rather than living in React state.
    await page.reload()
    await expect(page.getByTestId('items-list')).toContainText(secret)

    // Cross to the other tenant: Wes must not see it, and his own view starts empty.
    await signOut(page)
    await signInAs(page, 'person-other-tenant')
    await expect(page.getByTestId('active-tenant')).toHaveText('Westgate')
    await expect(page.getByTestId('items-card')).toBeVisible()
    await expect(page.getByTestId('items-card')).not.toContainText(secret)

    // ...and back again: Nadia's item is still there.
    await signOut(page)
    await signInAs(page, 'person-owner')
    await expect(page.getByTestId('items-list')).toContainText(secret)
})

test('the items list pages, and the endpoint refuses a cursor it cannot read', async ({ page }) => {
    await signInAs(page, 'person-owner')
    await expect(page.getByTestId('items-card')).toBeVisible()

    // The default page is 20, so 22 more items guarantee the list is longer than one page whatever else this
    // run has already written. Written through the route, the way the card's own add button does.
    const stamp = Date.now()
    for (let index = 0; index < 22; index++) {
        const response = await page.request.post('/api/items', { data: { title: `paged-${stamp}-${index}` } })
        expect(response.ok()).toBe(true)
    }
    await page.reload()
    const rows = page.getByTestId('item-row')
    await expect(rows).toHaveCount(20)
    await expect(page.getByTestId('items-load-more')).toBeVisible()

    // "Show older items" APPENDS: what is on screen stays, in the same order, and the button goes away at the
    // end of the list. Walked with a guard rather than one click, because this world keeps its rows between
    // runs and the list can be longer than two pages.
    let previous = await rows.allTextContents()
    for (let click = 0; click < 20; click++) {
        if (!(await page.getByTestId('items-load-more').isVisible())) break
        await page.getByTestId('items-load-more').click()
        await expect(rows).not.toHaveCount(previous.length)
        const current = await rows.allTextContents()
        expect(current.slice(0, previous.length)).toEqual(previous)
        previous = current
    }
    await expect(page.getByTestId('items-load-more')).toHaveCount(0)
    expect(previous.length).toBeGreaterThan(20)
    expect(new Set(previous).size).toBe(previous.length)

    // A malformed cursor is a 400, never a silent first page; the server also caps the page size itself.
    const bad = await page.request.get('/api/items?cursor=not-a-cursor')
    expect(bad.status()).toBe(400)
    expect(await bad.json()).toEqual({ error: 'invalid-cursor' })
    const single = await page.request.get('/api/items?limit=1')
    const onePage = (await single.json()) as { items: unknown[]; nextCursor: string | null }
    expect(onePage.items.length).toBe(1)
    expect(onePage.nextCursor).not.toBeNull()
    const greedy = await page.request.get('/api/items?limit=1000000')
    expect(greedy.status()).toBe(200)
    expect(((await greedy.json()) as { items: unknown[] }).items.length).toBeLessThanOrEqual(100)
})
