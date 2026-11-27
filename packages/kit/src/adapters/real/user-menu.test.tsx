import { MantineProvider } from '@mantine/core'
import { NextIntlClientProvider } from 'next-intl'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import enFramework from '../../i18n/messages/en.json'

/**
 * The header's real user menu with Clerk's hooks replaced (safeinsights/sssb#180): its sign-out goes through Clerk's
 * client, this session only, to the signed-out page, so the browser's session token goes with it; until Clerk has
 * loaded and knows the session, or when Clerk's sign-out fails, it signs out through the sign-out route instead.
 * Never run against a real Clerk instance (cutover row `auth-dev`).
 */
const clerk = vi.hoisted(() => ({
    signOut: vi.fn(async (options: unknown) => void options),
    sessionId: 'sess_1' as string | null,
    isLoaded: true,
}))
vi.mock('@clerk/nextjs', () => ({
    useClerk: () => ({ signOut: clerk.signOut }),
    useAuth: () => ({ isLoaded: clerk.isLoaded, sessionId: clerk.sessionId }),
}))

const fetchCalls: Array<[string, RequestInit | undefined]> = []
const assigned: string[] = []
const unmounts: Array<() => void> = []
beforeEach(() => {
    clerk.signOut.mockReset()
    clerk.sessionId = 'sess_1'
    clerk.isLoaded = true
    fetchCalls.length = 0
    assigned.length = 0
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
            fetchCalls.push([url, init])
            return new Response('{"ok":true}', { status: 200 })
        }),
    )
    vi.spyOn(window.location, 'assign').mockImplementation((url: string | URL) => {
        assigned.push(String(url))
    })
})
afterEach(() => {
    for (const unmount of unmounts.splice(0)) act(unmount)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

async function render(props: { profileHref?: string } = {}): Promise<HTMLElement> {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const { RealUserMenu } = await import('./user-menu')
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(
            <NextIntlClientProvider locale="en" messages={enFramework}>
                <MantineProvider>
                    <RealUserMenu
                        user={{ name: 'Pat Lane', email: 'pat@example.test' }}
                        signedOutHref="/en"
                        {...props}
                    />
                </MantineProvider>
            </NextIntlClientProvider>,
        )
    })
    unmounts.push(() => root.unmount())
    return container
}

/** Opens the menu (its dropdown renders in a portal on the document) and clicks the entry. */
async function choose(container: HTMLElement, testId: string): Promise<void> {
    await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="user-menu"]')!.click()
    })
    await act(async () => {
        document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click()
    })
}

describe('RealUserMenu', () => {
    it("signs out this session through Clerk's client, to the signed-out page, and not through the route", async () => {
        const container = await render()
        expect(clerk.signOut).not.toHaveBeenCalled()
        await choose(container, 'menu-signout')
        expect(clerk.signOut).toHaveBeenCalledWith({ sessionId: 'sess_1', redirectUrl: '/en' })
        expect(fetchCalls).toEqual([])
    })

    it.each([
        ['Clerk has not loaded', { isLoaded: false }],
        ['Clerk knows no session', { sessionId: null }],
    ])(
        'signs out through the sign-out route while %s: with no session id Clerk would end every session',
        async (_, state) => {
            Object.assign(clerk, state)
            const container = await render()
            await choose(container, 'menu-signout')
            expect(clerk.signOut).not.toHaveBeenCalled()
            expect(fetchCalls.map(([url, init]) => [url, init?.method])).toEqual([['/api/auth/signout', 'POST']])
            expect(assigned).toEqual(['/en'])
        },
    )

    it('falls back to the sign-out route when Clerk refuses the sign-out', async () => {
        clerk.signOut.mockRejectedValueOnce(new Error('network'))
        const container = await render()
        await choose(container, 'menu-signout')
        expect(fetchCalls.map(([url]) => url)).toEqual(['/api/auth/signout'])
        expect(assigned).toEqual(['/en'])
    })

    it('offers the profile entry only with a profile page, and goes there', async () => {
        const without = await render()
        await act(async () => {
            without.querySelector<HTMLButtonElement>('[data-testid="user-menu"]')!.click()
        })
        expect(document.querySelector('[data-testid="menu-profile"]')).toBeNull()
        for (const unmount of unmounts.splice(0)) act(unmount)

        const container = await render({ profileHref: '/en/profile' })
        await choose(container, 'menu-profile')
        expect(assigned).toEqual(['/en/profile'])
    })
})
