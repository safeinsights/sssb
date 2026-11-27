import { loadAppMessages } from '@sssb/app-config/messages'
import { NextIntlClientProvider } from 'next-intl'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { DemoWorldOptions } from './contracts'
import enFramework from '../i18n/messages/en.json'
import { mergeMessages } from '../i18n/messages'
import { useDemoWorld } from './world'

/**
 * The static demo's twin of `notifyJobTerminal` honours the seam's `jobNotify` (server-lib/notify-opt-out.test.ts
 * pins the server's side): the same kind, finished the same way, notifies the team's admins in the demo exactly
 * where it does on the server. Every job here completes, so `failure` is as silent as `never`; a failing job's
 * notification is world-job-retries.test.tsx's.
 */

type World = ReturnType<typeof useDemoWorld>

async function renderWorld(options: DemoWorldOptions): Promise<{ current: World }> {
    const messages = mergeMessages(enFramework, await loadAppMessages('en'))
    const result = {} as { current: World }
    function Probe() {
        result.current = useDemoWorld(options)
        return null
    }
    // React only flushes `act` updates in an environment that declares itself a test environment.
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const root = createRoot(document.createElement('div'))
    await act(async () => {
        root.render(
            <NextIntlClientProvider locale="en" messages={messages}>
                <Probe />
            </NextIntlClientProvider>,
        )
    })
    unmounts.push(() => root.unmount())
    return result
}

const unmounts: Array<() => void> = []
afterEach(() => {
    for (const unmount of unmounts.splice(0)) act(unmount)
})

const JOB_NOTIFY: NonNullable<DemoWorldOptions['jobNotify']> = { 'sweep-dockets': 'failure', 'quiet-dockets': 'never' }

describe('demo startJob and jobNotify', () => {
    it.each([
        ['export-dockets', 'says nothing, so it is always', true],
        ['sweep-dockets', 'is failure, and this job completed', false],
        ['quiet-dockets', 'is never', false],
    ])('%s (%s) notifies the team: %s', async (kind, _why, notifies) => {
        const world = await renderWorld({ jobNotify: JOB_NOTIFY })
        act(() => world.current.signIn('fixture-lead'))
        const before = world.current.notifications.length

        act(() => world.current.startJob(kind))

        // One per admin of the team, and which admins there are is the seed's business: count whether any came.
        expect(world.current.notifications.length > before).toBe(notifies)
    })

    it('notifies every kind when the app passes no jobNotify', async () => {
        const world = await renderWorld({})
        act(() => world.current.signIn('fixture-lead'))
        const before = world.current.notifications.length

        act(() => world.current.startJob('quiet-dockets'))

        expect(world.current.notifications.length).toBeGreaterThan(before)
    })

    // `wharf`, in the fixture's seed, has no admin: its one member is restricted. The server tells the person who
    // started the job when the team has no admin to tell (server-lib/notify-requester.test.ts); so does the twin.
    it('tells the person who started it when the team has no admin', async () => {
        const world = await renderWorld({})
        act(() => world.current.signIn('fixture-limited'))
        const before = world.current.notifications.length

        act(() => world.current.startJob('export-dockets'))

        const added = world.current.notifications.slice(0, world.current.notifications.length - before)
        expect(added.map((n) => n.recipientPersonId)).toEqual(['fixture-limited'])
    })
})
