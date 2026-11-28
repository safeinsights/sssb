import { MantineProvider } from '@mantine/core'
import { NextIntlClientProvider } from 'next-intl'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import en from '../../messages/en.json'
import { DashboardScreen } from './dashboard-screen'

/**
 * The assistant takes at most 2000 characters (POST /api/assistant answers 400 above it): the box stops there, and a
 * longer question is never sent, so a long question cannot end as the generic assistant error.
 */

// Mantine's autosizing Textarea listens on `document.fonts`, which happy-dom does not provide.
if (!('fonts' in document)) Object.defineProperty(document, 'fonts', { value: new EventTarget(), configurable: true })

const unmounts: Array<() => void> = []
afterEach(() => {
    for (const unmount of unmounts.splice(0)) act(unmount)
})

type Ask = (question: string, onDelta: (chunk: string) => void) => Promise<{ sources: string[] }>

async function renderScreen(ask: Ask = () => Promise.resolve({ sources: [] })) {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const onAsk = vi.fn(ask)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(
            <NextIntlClientProvider locale="en" messages={en}>
                <MantineProvider>
                    <DashboardScreen user={{ name: 'Dana', role: 'admin', restricted: false }} onAsk={onAsk} />
                </MantineProvider>
            </NextIntlClientProvider>,
        )
    })
    unmounts.push(() => root.unmount())
    const box = container.querySelector<HTMLTextAreaElement>('[data-testid="assistant-question"]')!
    const button = container.querySelector<HTMLButtonElement>('[data-testid="ask-button"]')!
    const type = async (value: string) => {
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, value)
            box.dispatchEvent(new Event('input', { bubbles: true }))
        })
    }
    return { box, button, type, onAsk, container }
}

describe('DashboardScreen assistant', () => {
    it('limits the question box to the 2000 characters the route accepts', async () => {
        const { box } = await renderScreen()
        expect(box.maxLength).toBe(2000)
    })

    it('asks a question of exactly 2000 characters, and never sends a longer one', async () => {
        const { button, type, onAsk } = await renderScreen()
        await type('q'.repeat(2001))
        expect(button.disabled).toBe(true)
        await act(async () => {
            button.click()
        })
        expect(onAsk).not.toHaveBeenCalled()

        await type('q'.repeat(2000))
        expect(button.disabled).toBe(false)
        await act(async () => {
            button.click()
        })
        expect(onAsk).toHaveBeenCalledTimes(1)
    })

    it('says an answer failed after it had begun, under the text that arrived, and not in its place', async () => {
        const { button, type, container } = await renderScreen(async (_question, onDelta) => {
            onDelta('The ticket was escalated and ')
            throw new Error('the stream reported: stream failed')
        })
        await type('what happened?')
        await act(async () => {
            button.click()
        })
        const answer = container.querySelector('[data-testid="assistant-answer"]')
        expect(answer?.textContent).toBe('The ticket was escalated and ')
        expect(container.querySelector('[data-testid="assistant-failed"]')?.textContent).toBe(
            en.dashboard.assistantError,
        )
    })

    it('shows the failure as the answer when nothing had arrived, with no second notice', async () => {
        const { button, type, container } = await renderScreen(() => Promise.reject(new Error('refused')))
        await type('what happened?')
        await act(async () => {
            button.click()
        })
        expect(container.querySelector('[data-testid="assistant-answer"]')?.textContent).toBe(
            en.dashboard.assistantError,
        )
        expect(container.querySelector('[data-testid="assistant-failed"]')).toBeNull()
    })
})
