import { MantineProvider } from '@mantine/core'
import { NextIntlClientProvider } from 'next-intl'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import enFramework from '../../i18n/messages/en.json'

/**
 * The real refused-account screen with Clerk's hooks replaced: it signs out through Clerk's client, this session only,
 * and only on the click, then returns through Clerk's `redirectUrl`. Never run against a real Clerk instance (cutover row `auth-tenancy`).
 */
const clerk = vi.hoisted(() => ({
    signOut: vi.fn(async () => {}),
    sessionId: 'sess_1' as string | null,
    isLoaded: true,
}))
vi.mock('@clerk/nextjs', () => ({
    useClerk: () => ({ signOut: clerk.signOut }),
    useAuth: () => ({ isLoaded: clerk.isLoaded, sessionId: clerk.sessionId }),
}))

const unmounts: Array<() => void> = []
beforeEach(() => {
    clerk.signOut.mockReset()
    clerk.sessionId = 'sess_1'
    clerk.isLoaded = true
})
afterEach(() => {
    for (const unmount of unmounts.splice(0)) act(unmount)
})

async function render(): Promise<HTMLElement> {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const { RealAccountRefused } = await import('./account-refused-form')
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(
            <NextIntlClientProvider locale="en" messages={enFramework}>
                <MantineProvider>
                    <RealAccountRefused />
                </MantineProvider>
            </NextIntlClientProvider>,
        )
    })
    unmounts.push(() => root.unmount())
    return container
}

const click = async (container: HTMLElement) =>
    act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="account-refused-signout"]')!.click()
    })

describe('RealAccountRefused', () => {
    it("signs out nothing until the person clicks, then this session only, back to this page, through Clerk's client", async () => {
        const container = await render()
        expect(clerk.signOut).not.toHaveBeenCalled()
        await click(container)
        expect(clerk.signOut).toHaveBeenCalledWith({ sessionId: 'sess_1', redirectUrl: window.location.href })
        expect(container.querySelector('[role="alert"]')).toBeNull()
    })

    it.each([
        ['Clerk has not loaded', { isLoaded: false }],
        ['Clerk knows no session', { sessionId: null }],
    ])(
        'signs nobody out, and says so, while %s: no session id would end every session on the device',
        async (_, state) => {
            Object.assign(clerk, state)
            const container = await render()
            await click(container)
            expect(clerk.signOut).not.toHaveBeenCalled()
            expect(container.querySelector('[role="alert"]')).not.toBeNull()
        },
    )

    it('shows the error when Clerk refuses the sign-out', async () => {
        clerk.signOut.mockRejectedValueOnce(new Error('network'))
        const container = await render()
        await click(container)
        expect(container.querySelector('[role="alert"]')).not.toBeNull()
    })
})
