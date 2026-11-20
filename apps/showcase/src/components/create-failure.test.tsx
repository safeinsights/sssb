import { MantineProvider } from '@mantine/core'
import { NextIntlClientProvider } from 'next-intl'
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import en from '../../messages/en.json'
import { EscalationsCard } from './escalations-card'
import { TicketsCard } from './tickets-card'

/** A create that fails keeps what the person typed and says so; one that succeeds clears the form. */

// Mantine's autosizing Textarea listens on `document.fonts`, which happy-dom does not provide.
if (!('fonts' in document)) Object.defineProperty(document, 'fonts', { value: new EventTarget(), configurable: true })

const unmounts: Array<() => void> = []
afterEach(() => {
    for (const unmount of unmounts.splice(0)) act(unmount)
})

async function render(node: ReactNode): Promise<HTMLElement> {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(
            <NextIntlClientProvider locale="en" messages={en}>
                <MantineProvider>{node}</MantineProvider>
            </NextIntlClientProvider>,
        )
    })
    unmounts.push(() => root.unmount())
    return container
}

const field = (container: HTMLElement, testId: string) =>
    container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-testid="${testId}"]`)!

/** React tracks a controlled field's value; set it through the native setter so onChange sees the change. */
async function type(container: HTMLElement, testId: string, value: string) {
    const element = field(container, testId)
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    await act(async () => {
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value)
        element.dispatchEvent(new Event('input', { bubbles: true }))
    })
}

async function click(container: HTMLElement, testId: string) {
    await act(async () => {
        container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click()
    })
}

async function ticketsWith(onCreate: () => Promise<void>) {
    const container = await render(
        <TicketsCard
            tickets={[]}
            assignees={[]}
            onCreate={onCreate}
            onUpdate={() => Promise.resolve()}
            onDelete={() => Promise.resolve()}
        />,
    )
    await type(container, 'ticket-input', 'printer on fire')
    await click(container, 'ticket-add')
    return container
}

async function escalationsWith(onCreate: () => Promise<void>) {
    const container = await render(
        <EscalationsCard
            sent={[]}
            received={[]}
            targets={[{ slug: 'b', name: 'Team B' }]}
            canCreate
            canRespond={false}
            onCreate={onCreate}
            onRespond={() => Promise.resolve()}
            onCancel={() => Promise.resolve()}
        />,
    )
    await act(async () => {
        field(container, 'escalation-target').click()
    })
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (o) => o.textContent === 'Team B',
    )!
    await act(async () => {
        option.click()
    })
    await type(container, 'escalation-subject', 'need help')
    await type(container, 'escalation-body', 'details')
    await click(container, 'escalation-create')
    return container
}

describe('TicketsCard create', () => {
    it('keeps the draft and shows an alert when the create fails', async () => {
        const container = await ticketsWith(() => Promise.reject(new Error('403')))
        expect(field(container, 'ticket-input').value).toBe('printer on fire')
        expect(container.querySelector('[role="alert"]')?.textContent).toBe(en.tickets.addError)
    })

    it('clears the draft, with no alert, when the create succeeds', async () => {
        const container = await ticketsWith(() => Promise.resolve())
        expect(field(container, 'ticket-input').value).toBe('')
        expect(container.querySelector('[role="alert"]')).toBeNull()
    })
})

describe('EscalationsCard create', () => {
    it('keeps the draft and shows an alert when the create fails', async () => {
        const container = await escalationsWith(() => Promise.reject(new Error('403')))
        expect(field(container, 'escalation-subject').value).toBe('need help')
        expect(container.querySelector('[role="alert"]')?.textContent).toBe(en.escalations.createError)
    })

    it('clears the draft, with no alert, when the create succeeds', async () => {
        const container = await escalationsWith(() => Promise.resolve())
        expect(field(container, 'escalation-subject').value).toBe('')
        expect(container.querySelector('[role="alert"]')).toBeNull()
    })
})
