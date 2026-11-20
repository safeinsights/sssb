import { MantineProvider } from '@mantine/core'
import { NextIntlClientProvider } from 'next-intl'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import enFramework from '../../i18n/messages/en.json'
import { AccountRefused } from './account-refused'

/**
 * A person the identity provider signed in but this app refuses is told why, and signs out only by choosing to: the
 * screen never calls `onSignOut` on its own, and a sign-out that fails says so and can be tried again.
 */

const unmounts: Array<() => void> = []
afterEach(() => {
    for (const unmount of unmounts.splice(0)) act(unmount)
})

async function render(onSignOut: () => void | Promise<boolean | void>): Promise<HTMLElement> {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(
            <NextIntlClientProvider locale="en" messages={enFramework}>
                <MantineProvider>
                    <AccountRefused onSignOut={onSignOut} />
                </MantineProvider>
            </NextIntlClientProvider>,
        )
    })
    unmounts.push(() => root.unmount())
    return container
}

const signOutButton = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>('[data-testid="account-refused-signout"]')!

describe('AccountRefused', () => {
    it('says why, and that signing out reaches other sites sharing the sign-in, before anyone clicks', async () => {
        const onSignOut = vi.fn()
        const container = await render(onSignOut)
        expect(container.textContent).toContain(enFramework.auth.refusedTitle)
        expect(container.textContent).toContain(enFramework.auth.refusedSignOutNote)
        expect(onSignOut).not.toHaveBeenCalled()
    })

    it('signs out only when the person clicks, and keeps the spinner while the page reloads', async () => {
        const onSignOut = vi.fn(async () => true)
        const container = await render(onSignOut)
        await act(async () => {
            signOutButton(container).click()
        })
        expect(onSignOut).toHaveBeenCalledTimes(1)
        expect(signOutButton(container).hasAttribute('data-loading')).toBe(true)
        expect(container.querySelector('[role="alert"]')).toBeNull()
    })

    it.each([
        ['answers false', async () => false],
        ['rejects', async () => Promise.reject(new Error('offline'))],
    ])('shows the error and lets them try again when the sign-out %s', async (_, onSignOut) => {
        const container = await render(onSignOut)
        await act(async () => {
            signOutButton(container).click()
        })
        expect(container.querySelector('[role="alert"]')?.textContent).toBe(enFramework.auth.refusedSignOutError)
        expect(signOutButton(container).hasAttribute('data-loading')).toBe(false)
    })
})
