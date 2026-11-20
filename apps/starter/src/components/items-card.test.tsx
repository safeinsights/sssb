import { MantineProvider } from '@mantine/core'
import { NextIntlClientProvider } from 'next-intl'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import en from '../../messages/en.json'
import { ItemsCard } from './items-card'

/** A create that fails keeps what the person typed and says so; one that succeeds clears the box. */

const unmounts: Array<() => void> = []
afterEach(() => {
    for (const unmount of unmounts.splice(0)) act(unmount)
})

async function addWith(onAdd: (title: string) => Promise<void>): Promise<HTMLElement> {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(
            <NextIntlClientProvider locale="en" messages={en}>
                <MantineProvider>
                    <ItemsCard items={[]} onAdd={onAdd} />
                </MantineProvider>
            </NextIntlClientProvider>,
        )
    })
    unmounts.push(() => root.unmount())
    const input = container.querySelector<HTMLInputElement>('[data-testid="item-input"]')!
    await act(async () => {
        // React tracks a controlled input's value; set it through the native setter so onChange sees the change.
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'my important draft')
        input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="item-add"]')!.click()
    })
    return container
}

const inputValue = (container: HTMLElement) =>
    container.querySelector<HTMLInputElement>('[data-testid="item-input"]')!.value

describe('ItemsCard', () => {
    it('keeps the draft and shows an alert when the create fails', async () => {
        const container = await addWith(() => Promise.reject(new Error('403')))
        expect(inputValue(container)).toBe('my important draft')
        expect(container.querySelector('[role="alert"]')?.textContent).toBe(en.items.addError)
    })

    it('clears the draft, with no alert, when the create succeeds', async () => {
        const container = await addWith(() => Promise.resolve())
        expect(inputValue(container)).toBe('')
        expect(container.querySelector('[role="alert"]')).toBeNull()
    })
})
