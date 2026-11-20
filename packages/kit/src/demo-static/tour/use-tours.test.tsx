import { MantineProvider } from '@mantine/core'
import { NextIntlClientProvider } from 'next-intl'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import enFramework from '../../i18n/messages/en.json'
import { useTours, type ToursHandle } from './use-tours'

/** Exit while a step's advance script runs ends the tour: the pending Next must not re-open it on the next step. */

vi.mock('@sssb/app-config/tours', () => ({
    tours: [
        {
            id: 'probe',
            titleKey: 'probe.title',
            summaryKey: 'probe.summary',
            steps: [{ textKey: 'probe.one', advance: [['pause', 400]] }, { textKey: 'probe.two' }],
        },
    ],
}))

const messages = { ...enFramework, probe: { title: 'Probe', summary: 'Probe', one: 'One', two: 'Two' } }

const unmounts: Array<() => void> = []
afterEach(() => {
    for (const unmount of unmounts.splice(0)) act(unmount)
    window.sessionStorage.clear()
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('useTours', () => {
    it('stays ended when Exit is pressed while a step advances', async () => {
        ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
        const handle = {} as { current: ToursHandle }
        function Probe() {
            handle.current = useTours()
            return <>{handle.current.overlay}</>
        }
        const container = document.createElement('div')
        document.body.append(container)
        const root = createRoot(container)
        await act(async () => {
            root.render(
                <NextIntlClientProvider locale="en" messages={messages}>
                    <MantineProvider>
                        <Probe />
                    </MantineProvider>
                </NextIntlClientProvider>,
            )
        })
        unmounts.push(() => root.unmount())
        const button = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)

        await act(async () => {
            handle.current.tab!.onStart('probe')
        })
        expect(button('tour-exit')).not.toBeNull()
        await act(async () => {
            button('tour-next')!.click()
            await sleep(100)
        })
        await act(async () => {
            button('tour-exit')!.click()
        })
        await act(() => sleep(1_000))
        expect(button('tour-exit')).toBeNull()
        expect(handle.current.tab!.activeId).toBeNull()
    })
})
