import { loadAppMessages } from '@sssb/app-config/messages'
import { NextIntlClientProvider } from 'next-intl'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import enFramework from '../i18n/messages/en.json'
import { mergeMessages } from '../i18n/messages'
import { useDemoWorld } from './world'

/**
 * A job's terminal hop emits what the server emits, for the JOB's org, whoever is looking: the `job.status_changed`
 * webhook to that org's endpoints from every path, and the notification to its admins from every path but the
 * service actor's (its server route calls recordJobStatus alone).
 */

type World = ReturnType<typeof useDemoWorld>

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
})

/** Ada administers depot and annex: an endpoint on each, then a held job started in depot. */
async function heldDepotJob() {
    const world = await renderWorld()
    act(() => world.current.signIn('fixture-lead'))
    act(() => world.current.setActiveOrgSlug('depot'))
    act(() =>
        world.current.createEndpoint({ url: 'https://depot.example.test/hook', eventKinds: ['job.status_changed'] }),
    )
    act(() => world.current.setActiveOrgSlug('annex'))
    act(() =>
        world.current.createEndpoint({ url: 'https://annex.example.test/hook', eventKinds: ['job.status_changed'] }),
    )
    act(() => world.current.setActiveOrgSlug('depot'))
    act(() => world.current.setFeatureFlag('jobs-held', true))
    act(() => world.current.startJob('export-dockets'))
    const job = world.current.jobs[0]!
    expect(job).toMatchObject({ orgSlug: 'depot', status: 'queued' })
    const endpointOf = (org: string) => world.current.endpoints.find((e) => e.orgSlug === org)!.id
    const deliveredTo = () => world.current.deliveries.map((d) => d.endpointId)
    const jobNotices = () => world.current.notifications.filter((n) => n.kind === 'job.completed').length
    return { world, job, endpointOf, deliveredTo, jobNotices }
}

describe('demo job terminal hop', () => {
    it("delivers a held job's webhook to the job's org, even when run from another org", async () => {
        const { world, endpointOf, deliveredTo } = await heldDepotJob()
        act(() => world.current.setActiveOrgSlug('annex'))
        act(() => world.current.runPendingJobs())
        expect(deliveredTo()).toEqual([endpointOf('depot')])
    })

    it('emits the webhook, and notifies no one, when a service actor completes the job (as its route does)', async () => {
        const { world, job, endpointOf, deliveredTo, jobNotices } = await heldDepotJob()
        const before = jobNotices()
        const driver = world.current.serviceDriver({ tenantSlug: 'harbor', orgSlug: 'depot' }, () => {})
        await act(async () => {
            expect(await driver.claim(job.id)).toBe('applied')
        })
        await act(async () => {
            expect(await driver.complete(job.id)).toBe('applied')
        })
        expect(deliveredTo()).toEqual([endpointOf('depot')])
        expect(jobNotices()).toBe(before)
    })

    it('emits them when the builder completes the job', async () => {
        const { world, endpointOf, deliveredTo, jobNotices } = await heldDepotJob()
        const before = jobNotices()
        const driver = world.current.builderDriver([], () => {})
        const [build] = await driver.listBuilds()
        await act(async () => {
            expect(await driver.deliver(build!)).toBe('applied')
        })
        expect(deliveredTo()).toEqual([endpointOf('depot')])
        expect(jobNotices()).toBeGreaterThan(before)
    })
})
