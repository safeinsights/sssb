import { MantineProvider } from '@mantine/core'
import { NextIntlClientProvider } from 'next-intl'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import enFramework from '../../i18n/messages/en.json'
import { UserMenu } from './user-menu'

const unmounts: Array<() => void> = []
afterEach(() => {
    for (const unmount of unmounts.splice(0)) act(unmount)
})

async function trigger(user: { name: string; email: string }): Promise<HTMLElement> {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(
            <NextIntlClientProvider locale="en" messages={enFramework}>
                <MantineProvider>
                    <UserMenu user={user} onSignOut={() => {}} />
                </MantineProvider>
            </NextIntlClientProvider>,
        )
    })
    unmounts.push(() => root.unmount())
    return container.querySelector<HTMLElement>('[data-testid="user-menu"]')!
}

/** The trigger's avatar shows the letters `avatarInitials` derives, not Mantine's first character of each word. */
describe('UserMenu avatar', () => {
    it('shows the first and last letter-words, not a punctuation character', async () => {
        const button = await trigger({ name: 'Ana (Bea) Cruz', email: 'ana@example.test' })
        const avatar = button.querySelector('[aria-hidden="true"]')!
        expect(avatar.textContent).toBe('AC')
    })

    it('falls back to the email when the name has no letters', async () => {
        const button = await trigger({ name: '(  )', email: 'dana@example.test' })
        expect(button.querySelector('[aria-hidden="true"]')!.textContent).toBe('D')
    })
})
