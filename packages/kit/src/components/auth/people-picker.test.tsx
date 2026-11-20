import { MantineProvider } from '@mantine/core'
import { NextIntlClientProvider } from 'next-intl'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import enFramework from '../../i18n/messages/en.json'
import { PeoplePicker } from './people-picker'

/** A failed sign-in clears the picked person's spinner, so they can pick again; one that navigates keeps it. */

const unmounts: Array<() => void> = []
afterEach(() => {
    for (const unmount of unmounts.splice(0)) act(unmount)
})

const people = [{ id: 'p1', name: 'Pat', role: 'owner', tenantName: 'Harbor' }]

async function pick(onPick: () => Promise<boolean>): Promise<HTMLButtonElement> {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(
            <NextIntlClientProvider locale="en" messages={enFramework}>
                <MantineProvider>
                    <PeoplePicker people={people} onPick={onPick} />
                </MantineProvider>
            </NextIntlClientProvider>,
        )
    })
    unmounts.push(() => root.unmount())
    const button = container.querySelector<HTMLButtonElement>('[data-testid="person-p1"]')!
    await act(async () => {
        button.click()
    })
    return button
}

const loading = (button: HTMLButtonElement) => button.hasAttribute('data-loading')

describe('PeoplePicker', () => {
    it('clears the spinner when the sign-in is refused', async () => {
        expect(loading(await pick(() => Promise.resolve(false)))).toBe(false)
    })

    it('clears the spinner when the sign-in request fails', async () => {
        expect(loading(await pick(() => Promise.reject(new Error('offline'))))).toBe(false)
    })

    it('keeps the spinner while a successful sign-in navigates', async () => {
        expect(loading(await pick(() => Promise.resolve(true)))).toBe(true)
    })
})
