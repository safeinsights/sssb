import { MantineProvider } from '@mantine/core'
import { NextIntlClientProvider } from 'next-intl'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import enFramework from '@sssb/kit/i18n/messages/en.json'
import { mergeMessages } from '@sssb/kit/i18n/messages'
import en from '../../../../../messages/en.json'
import { DashboardGlue } from './dashboard-glue'

/**
 * The queue re-anchors on page one after every mutation. A "Show more" page still in flight when that refresh lands
 * belongs to the list the reader was looking at before it, so it must be dropped, not appended to the new one.
 */

// Mantine's autosizing Textarea listens on `document.fonts`, which happy-dom does not provide.
if (!('fonts' in document)) Object.defineProperty(document, 'fonts', { value: new EventTarget(), configurable: true })

const unmounts: Array<() => void> = []
afterEach(() => {
    for (const unmount of unmounts.splice(0)) act(unmount)
    vi.unstubAllGlobals()
})

const ticket = (id: string) => ({
    id,
    ref: id.toUpperCase(),
    subject: `subject ${id}`,
    body: '',
    status: 'open',
    assigneeUserId: null,
    createdAt: '2026-11-17T12:00:00.000Z',
})

describe('DashboardGlue tickets', () => {
    it('drops a next page that lands after the list was refreshed', async () => {
        ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
        let releasePage2: () => void = () => {}
        const page2 = new Promise<Response>((resolve) => {
            releasePage2 = () => resolve(Response.json({ tickets: [ticket('b')], nextCursor: null }))
        })
        let firstPages = 0
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string, init?: RequestInit) => {
                if (url === '/api/tickets' && init?.method === 'POST') return Promise.resolve(Response.json({}))
                if (url === '/api/tickets') {
                    firstPages += 1
                    const tickets = firstPages === 1 ? [ticket('a')] : [ticket('n'), ticket('a')]
                    return Promise.resolve(Response.json({ tickets, nextCursor: 'c1' }))
                }
                if (url === '/api/tickets?cursor=c1') return page2
                if (url === '/api/jobs') return Promise.resolve(Response.json({ jobs: [] }))
                if (url === '/api/escalations')
                    return Promise.resolve(Response.json({ sent: [], received: [], targets: [] }))
                if (url === '/api/attachments') return Promise.resolve(Response.json({ attachments: [] }))
                return Promise.resolve(new Response(null, { status: 404 }))
            }),
        )
        const container = document.createElement('div')
        document.body.append(container)
        const root = createRoot(container)
        await act(async () => {
            root.render(
                <NextIntlClientProvider locale="en" messages={mergeMessages(enFramework, en)}>
                    <MantineProvider>
                        <DashboardGlue
                            user={{ name: 'Dana', role: 'admin' }}
                            assignees={[]}
                            canCreateTicket
                            canUpdateTicket
                            canCreateEscalation={false}
                            canRespondEscalation={false}
                            canCreateAttachment={false}
                            canCreateJob={false}
                            slaHighlight={false}
                        />
                    </MantineProvider>
                </NextIntlClientProvider>,
            )
        })
        unmounts.push(() => root.unmount())
        const testId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!

        // Show more: page two is now in flight.
        await act(async () => {
            testId('tickets-load-more').click()
        })
        // A create re-anchors the queue on page one, which lands first.
        const input = testId('ticket-input') as HTMLInputElement
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'new one')
            input.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await act(async () => {
            testId('ticket-add').click()
        })
        // Then the stale page two lands.
        await act(async () => {
            releasePage2()
            await page2
        })

        const rows = [...container.querySelectorAll('[data-testid="ticket-item"]')].map(
            (row) => row.textContent?.match(/subject (\w)/)?.[1],
        )
        expect(rows).toEqual(['n', 'a'])
    })
})
