import { MantineProvider } from '@mantine/core'
import { NextIntlClientProvider } from 'next-intl'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import enFramework from '../../i18n/messages/en.json'
import { AcceptInviteScreen } from './accept-invite-screen'

/** A failed accept is announced: the error is an alert, so a screen reader says it without the user hunting for it. */

const unmounts: Array<() => void> = []
afterEach(() => {
    for (const unmount of unmounts.splice(0)) act(unmount)
})

describe('AcceptInviteScreen', () => {
    it('renders its error as an alert', async () => {
        ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
        const container = document.createElement('div')
        document.body.append(container)
        const root = createRoot(container)
        await act(async () => {
            root.render(
                <NextIntlClientProvider locale="en" messages={enFramework}>
                    <MantineProvider>
                        <AcceptInviteScreen
                            state={{
                                kind: 'valid',
                                inviteId: 'i1',
                                orgName: 'Harbor',
                                role: 'member',
                                email: 'a@b.test',
                            }}
                            error="That did not work"
                            onAccept={() => Promise.resolve()}
                            onSignIn={() => {}}
                        />
                    </MantineProvider>
                </NextIntlClientProvider>,
            )
        })
        unmounts.push(() => root.unmount())
        expect(container.querySelector('[role="alert"]')?.textContent).toBe('That did not work')
    })
})
