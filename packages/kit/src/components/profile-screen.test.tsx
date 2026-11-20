import { MantineProvider } from '@mantine/core'
import { NextIntlClientProvider } from 'next-intl'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import enFramework from '../i18n/messages/en.json'
import { ProfileScreen, type ProfileValues } from './profile-screen'

/**
 * The auth adapters refuse a profile name that is blank or longer than 256 characters, so the screen holds the same
 * rule before it saves, and a save that fails anyway is said, with what the person typed still in the form.
 */

const unmounts: Array<() => void> = []
afterEach(() => {
    for (const unmount of unmounts.splice(0)) act(unmount)
})

async function renderScreen(onSave: (values: ProfileValues) => Promise<void>) {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(
            <NextIntlClientProvider locale="en" messages={enFramework}>
                <MantineProvider>
                    <ProfileScreen
                        initial={{ name: 'Ada Keeper', locale: 'en' }}
                        email="ada@example.test"
                        locales={['en', 'es']}
                        onSave={onSave}
                    />
                </MantineProvider>
            </NextIntlClientProvider>,
        )
    })
    unmounts.push(() => root.unmount())
    const name = container.querySelector<HTMLInputElement>('[data-testid="profile-name"]')!
    return {
        container,
        name,
        async type(value: string) {
            await act(async () => {
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, value)
                name.dispatchEvent(new Event('input', { bubbles: true }))
            })
        },
        async save() {
            await act(async () => {
                container.querySelector<HTMLButtonElement>('[data-testid="profile-save"]')!.click()
            })
        },
    }
}

describe('ProfileScreen', () => {
    it('does not submit a blank name, and says why', async () => {
        const onSave = vi.fn(() => Promise.resolve())
        const screen = await renderScreen(onSave)
        await screen.type('   ')
        await screen.save()
        expect(onSave).not.toHaveBeenCalled()
        expect(screen.container.textContent).toContain(enFramework.profile.nameRequired)
    })

    it('does not submit a name longer than the adapters accept', async () => {
        const onSave = vi.fn(() => Promise.resolve())
        const screen = await renderScreen(onSave)
        await screen.type('x'.repeat(257))
        await screen.save()
        expect(onSave).not.toHaveBeenCalled()
    })

    it('shows an alert and keeps the typed name when the save fails', async () => {
        const screen = await renderScreen(() => Promise.reject(new Error('403')))
        await screen.type('Ada K.')
        await screen.save()
        expect(screen.container.querySelector('[role="alert"]')?.textContent).toBe(enFramework.profile.saveError)
        expect(screen.name.value).toBe('Ada K.')
        expect(screen.container.querySelector('[data-testid="profile-saved"]')).toBeNull()
    })
})
