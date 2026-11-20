import { loadAppMessages } from '@sssb/app-config/messages'
import { NextIntlClientProvider } from 'next-intl'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import enFramework from '../i18n/messages/en.json'
import { mergeMessages } from '../i18n/messages'
import { useDemoWorld } from './world'

/**
 * The demo's seeded schedule against its world clock. The fixture seeds no schedule, so this file gives it one: a
 * daily digest for depot (02:00 UTC), whose admin is Ada.
 */

vi.mock('@sssb/app-config/seed', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    jobSchedules: [
        {
            tenantSlug: 'harbor',
            orgSlug: 'depot',
            kind: 'digest-email',
            spec: { type: 'daily', atUtcHour: 2, atUtcMinute: 0 },
            createdBy: 'seed',
        },
    ],
}))

type World = ReturnType<typeof useDemoWorld>

const DAY_MS = 86_400_000

async function renderWorld(): Promise<{ current: World }> {
    const messages = mergeMessages(enFramework, await loadAppMessages('en'))
    const result = {} as { current: World }
    function Probe() {
        result.current = useDemoWorld()
        return null
    }
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
    vi.useRealTimers()
})

describe('the demo twin marks mail seen at its world clock', () => {
    it('clears the unread count for a digest dated a week on, once the person has looked', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date('2026-11-17T12:00:00.000Z').getTime())
        const world = await renderWorld()
        act(() => world.current.signIn('fixture-lead'))
        const unread = () => world.current.people.find((p) => p.key === 'person:fixture-lead')!.unreadMail

        act(() => world.current.clock.advance(7 * DAY_MS))
        expect(unread()).toBeGreaterThan(0)
        act(() => world.current.mail.markSeen())
        expect(unread()).toBe(0)
    })
})

describe('the demo twin reseeds its schedules at its world clock', () => {
    it('computes the next run after a reset from world now, not from real now', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        const mountedAt = new Date('2026-11-17T12:00:00.000Z').getTime()
        vi.setSystemTime(mountedAt)
        const world = await renderWorld()
        // A real day passes, crossing 02:00 on the 18th; the reset puts the world clock back at its mount time.
        vi.setSystemTime(mountedAt + DAY_MS)
        act(() => world.current.resetWorld())
        expect(world.current.clock.worldNowIso).toBe('2026-11-17T12:00:00.000Z')
        expect(world.current.schedules[0]!.nextRunAt).toBe('2026-11-18T02:00:00.000Z')
    })
})
