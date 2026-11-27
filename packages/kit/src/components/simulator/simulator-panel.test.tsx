import { loadAppMessages } from '@sssb/app-config/messages'
import { MantineProvider } from '@mantine/core'
import { NextIntlClientProvider } from 'next-intl'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import enFramework from '../../i18n/messages/en.json'
import { mergeMessages } from '../../i18n/messages'
import { SimulatorPanel } from './simulator-panel'

/**
 * A host wires the tabs it serves (the kit's server host wires every framework tab): every other tab is
 * left out of the strip, and a tab remembered from a host that showed it falls back to People.
 */

const unmounts: Array<() => void> = []
afterEach(() => {
    for (const unmount of unmounts.splice(0)) act(unmount)
    window.localStorage.clear()
})

async function renderPanel(): Promise<HTMLElement> {
    const messages = mergeMessages(enFramework, await loadAppMessages('en'))
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
        root.render(
            <NextIntlClientProvider locale="en" messages={messages}>
                <MantineProvider>
                    <SimulatorPanel
                        people={[]}
                        viewpoint={null}
                        signedIn={false}
                        onSelect={() => {}}
                        mail={{
                            emails: [],
                            scope: 'all',
                            onScopeChange: () => {},
                            personEmail: null,
                            onOpenLink: () => {},
                            onSeen: () => {},
                        }}
                        jobs={{ jobs: [], held: false }}
                    />
                </MantineProvider>
            </NextIntlClientProvider>,
        )
    })
    unmounts.push(() => {
        root.unmount()
        container.remove()
    })
    return container
}

const tab = (container: HTMLElement, id: string) => container.querySelector(`[data-testid="simulator-tab-${id}"]`)

describe('SimulatorPanel: the tabs a host wires', () => {
    it('shows People and the wired tabs, and leaves every other tab out', async () => {
        window.localStorage.setItem('app-simulator-collapsed', 'false')
        const container = await renderPanel()
        for (const id of ['people', 'mail', 'jobs']) expect(tab(container, id), id).not.toBeNull()
        for (const id of ['messages', 'events', 'hooks', 'errors', 'snapshots', 'tours']) {
            expect(tab(container, id), id).toBeNull()
        }
    })

    it('falls back to People when the remembered tab is one this host does not show', async () => {
        window.localStorage.setItem('app-simulator-collapsed', 'false')
        window.localStorage.setItem('app-simulator-tab', 'hooks')
        const container = await renderPanel()
        expect(container.querySelector('[data-testid="simulator-people"]')).not.toBeNull()
    })

    it('keeps a remembered tab the host does show', async () => {
        window.localStorage.setItem('app-simulator-collapsed', 'false')
        window.localStorage.setItem('app-simulator-tab', 'jobs')
        const container = await renderPanel()
        expect(container.querySelector('[data-testid="simulator-people"]')).toBeNull()
        expect(container.querySelector('[data-testid="simulator-jobs"]')).not.toBeNull()
    })
})
