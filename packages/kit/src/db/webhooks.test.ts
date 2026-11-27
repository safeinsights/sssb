import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { makeTestTmpDir } from '../testing/tmp-dir'
import { orgIdForSlug } from './org-lookup'
import { tenantIdForSlug } from './tenant-lookup'
import { backoffDelayMs } from '../core/webhook-events'
import { verifyWebhookSignature, WEBHOOK_REPLAY_TOLERANCE_MS, WEBHOOK_SIGNATURE_HEADER } from '../core/webhook-signing'

// Point all fake-adapter state at a throwaway dir BEFORE importing anything that touches pglite / the
// webhook catch-store. Simulated mode is the default (APP_MODE !== 'real'), so the drain uses the fake
// dispatch (catch-store + failure toggle) under this dir.
const tmp = makeTestTmpDir('app-webhooks-db-')
beforeAll(() => {
    process.env['APP_DATA_DIR'] = tmp
})
afterAll(() => {
    delete process.env['APP_DATA_DIR']
})

async function ids(slug: string, orgSlug: string): Promise<{ tenantId: string; orgId: string }> {
    const { fakeDb } = await import('../adapters/fake/db')
    await fakeDb.ready()
    const tenantId = await tenantIdForSlug(fakeDb, slug)
    if (!tenantId) throw new Error(`no tenant: ${slug}`)
    const orgId = await orgIdForSlug(fakeDb, tenantId, orgSlug)
    if (!orgId) throw new Error(`no org: ${orgSlug}`)
    return { tenantId, orgId }
}

const T0 = new Date('2027-01-01T00:00:00.000Z')

describe('webhook emission + drain', () => {
    test('delivers a job.status_changed event and signs it verifiably', async () => {
        const { fakeDb } = await import('../adapters/fake/db')
        const { createEndpoint, enqueueWebhookEvent, runDueDeliveries, listDeliveriesForWorld } =
            await import('./webhooks')
        const { readCaughtWebhook, fakeDispatchWebhook } = await import('../adapters/fake/webhooks')
        const { tenantId, orgId } = await ids('harbor', 'depot')

        const secret = 'whsec_happy'
        const { id: endpointId } = await createEndpoint(fakeDb, {
            tenantId,
            orgId,
            url: 'https://happy.example.test/hook',
            eventKinds: ['job.status_changed'],
            secret,
            createdBy: 'test',
        })

        const enqueued = await enqueueWebhookEvent(
            fakeDb,
            {
                tenantId,
                orgId,
                kind: 'job.status_changed',
                payload: { jobId: 'j1', jobKind: 'export-dockets', status: 'completed', orgId },
            },
            T0,
        )
        expect(enqueued).toBe(1)

        const result = await runDueDeliveries(fakeDb, T0, fakeDispatchWebhook)
        expect(result.delivered).toBe(1)

        const deliveries = (await listDeliveriesForWorld(fakeDb)).filter((d) => d.endpointId === endpointId)
        expect(deliveries).toHaveLength(1)
        expect(deliveries[0]!.status).toBe('delivered')
        expect(deliveries[0]!.attemptCount).toBe(1)

        // The caught egress carries a signature that VERIFIES against the endpoint secret and body.
        const caught = readCaughtWebhook(deliveries[0]!.id)
        expect(caught).not.toBeNull()
        const verified = verifyWebhookSignature(caught!.body, caught!.headers[WEBHOOK_SIGNATURE_HEADER], secret, {
            toleranceMs: WEBHOOK_REPLAY_TOLERANCE_MS,
            now: T0,
        })
        expect(verified).toEqual({ ok: true })
        // The signed body is the envelope carrying the delivery id (for consumer dedupe) + the payload.
        expect(JSON.parse(caught!.body)).toMatchObject({ id: deliveries[0]!.id, kind: 'job.status_changed' })
    })

    test('retries a failing endpoint on the backoff schedule, then recovers', async () => {
        const { fakeDb } = await import('../adapters/fake/db')
        const { createEndpoint, enqueueWebhookEvent, runDueDeliveries, listDeliveriesForWorld } =
            await import('./webhooks')
        const { setEndpointFailing, fakeDispatchWebhook } = await import('../adapters/fake/webhooks')
        const { tenantId, orgId } = await ids('harbor', 'depot')

        const { id: endpointId } = await createEndpoint(fakeDb, {
            tenantId,
            orgId,
            url: 'https://flaky.example.test/hook',
            // An APP-registered kind (the fixture seam's), where the happy-path test above used the
            // framework's own — so the composed registry is exercised from both sides.
            eventKinds: ['docket.filed'],
            secret: 'whsec_flaky',
            createdBy: 'test',
        })
        setEndpointFailing(endpointId, true)

        await enqueueWebhookEvent(
            fakeDb,
            {
                tenantId,
                orgId,
                kind: 'docket.filed',
                payload: { docketId: 'd1', label: 'l', orgId },
            },
            T0,
        )

        const only = async () => (await listDeliveriesForWorld(fakeDb)).filter((d) => d.endpointId === endpointId)[0]!

        // First attempt fails; armed for retry.
        const r1 = await runDueDeliveries(fakeDb, T0, fakeDispatchWebhook)
        expect(r1.failed).toBe(1)
        const afterFail = await only()
        expect(afterFail.status).toBe('failed')
        expect(afterFail.attemptCount).toBe(1)
        // next_attempt_at is armed ~backoff(1) into the future — not due at T0.
        expect(new Date(afterFail.nextAttemptAt).getTime()).toBe(T0.getTime() + backoffDelayMs(1))

        // A second drain at the SAME instant is a no-op (not due).
        const r1b = await runDueDeliveries(fakeDb, T0, fakeDispatchWebhook)
        expect(r1b.delivered + r1b.failed + r1b.dead).toBe(0)

        // After the backoff elapses, it retries (attempt 2, still failing).
        const t2 = new Date(T0.getTime() + backoffDelayMs(1) + 1_000)
        const r2 = await runDueDeliveries(fakeDb, t2, fakeDispatchWebhook)
        expect(r2.failed).toBe(1)
        expect((await only()).attemptCount).toBe(2)

        // Recover: toggle failure off, advance past the next backoff → delivered.
        setEndpointFailing(endpointId, false)
        const t3 = new Date(t2.getTime() + backoffDelayMs(2) + 1_000)
        const r3 = await runDueDeliveries(fakeDb, t3, fakeDispatchWebhook)
        expect(r3.delivered).toBe(1)
        const recovered = await only()
        expect(recovered.status).toBe('delivered')
        expect(recovered.attemptCount).toBe(3)
    })

    test('a disabled endpoint receives no deliveries', async () => {
        const { fakeDb } = await import('../adapters/fake/db')
        const { createEndpoint, setEndpointEnabled, enqueueWebhookEvent, listDeliveriesForWorld } =
            await import('./webhooks')
        const { tenantId, orgId } = await ids('harbor', 'depot')

        const { id: endpointId } = await createEndpoint(fakeDb, {
            tenantId,
            orgId,
            url: 'https://off.example.test/hook',
            eventKinds: ['job.status_changed'],
            secret: 'whsec_off',
            createdBy: 'test',
        })
        await setEndpointEnabled(fakeDb, tenantId, endpointId, false)

        // Other enabled endpoints in this org (from earlier tests) may still match; assert specifically
        // that the DISABLED endpoint got no delivery row.
        await enqueueWebhookEvent(
            fakeDb,
            {
                tenantId,
                orgId,
                kind: 'job.status_changed',
                payload: { jobId: 'j2', jobKind: 'x', status: 'running', orgId },
            },
            T0,
        )
        const forOff = (await listDeliveriesForWorld(fakeDb)).filter((d) => d.endpointId === endpointId)
        expect(forOff).toHaveLength(0)
    })
})

describe('the delivery drain is bounded per tick and fair across tenants (safeinsights/sssb#97)', () => {
    test("a tenant with a long backlog to a slow endpoint cannot starve another tenant's delivery, and nothing it leaves is lost or sent twice", async () => {
        const { fakeDb } = await import('../adapters/fake/db')
        const { createEndpoint, enqueueWebhookEvent, runDueDeliveries, listDeliveriesForWorld } =
            await import('./webhooks')
        const { fakeDispatchWebhook } = await import('../adapters/fake/webhooks')
        // Long before every other test's rows, so only this test's deliveries are due at `due`.
        const enqueuedAt = new Date('2025-01-01T00:00:00.000Z')
        const due = new Date('2025-01-01T01:00:00.000Z')

        const busy = await ids('harbor', 'annex')
        const quiet = await ids('lakeside', 'wharf')
        const endpoint = async (who: { tenantId: string; orgId: string }, url: string) =>
            (
                await createEndpoint(fakeDb, {
                    ...who,
                    url,
                    eventKinds: ['job.status_changed'],
                    secret: 'whsec_fair',
                    createdBy: 'test',
                })
            ).id
        const slowId = await endpoint(busy, 'https://slow.example.test/hook')
        const quietId = await endpoint(quiet, 'https://quiet.example.test/hook')
        const event = (who: { tenantId: string; orgId: string }, jobId: string, at: Date) =>
            enqueueWebhookEvent(
                fakeDb,
                {
                    ...who,
                    kind: 'job.status_changed',
                    payload: { jobId, jobKind: 'export-dockets', status: 'completed', orgId: who.orgId },
                },
                at,
            )
        // The busy tenant's twenty deliveries are all older than the quiet tenant's one.
        for (let i = 0; i < 20; i++) await event(busy, `busy-${i}`, enqueuedAt)
        await event(quiet, 'quiet-0', new Date(enqueuedAt.getTime() + 60_000))

        // Every POST to the slow endpoint takes ten seconds of the tick's clock, the real dispatcher's timeout.
        let clock = 0
        const sent: string[] = []
        const dispatch: typeof fakeDispatchWebhook = (input) => {
            sent.push(input.deliveryId)
            if (input.endpointId === slowId) clock += 10_000
            return fakeDispatchWebhook(input)
        }
        const mine = async (endpointId: string) =>
            (await listDeliveriesForWorld(fakeDb)).filter((d) => d.endpointId === endpointId)

        const first = await runDueDeliveries(fakeDb, due, dispatch, {
            maxItems: 100,
            deadline: 25_000,
            clock: () => clock,
        })
        // Whichever tenant the tick's rotation puts first, the quiet tenant's one delivery is in the first round, and the
        // busy tenant's start at 0, 10 and 20 seconds; at 30 the window had closed.
        expect(first).toEqual({ delivered: 4, failed: 0, dead: 0, deferred: 17, stoppedBy: 'time' })
        expect((await mine(quietId)).map((d) => d.status)).toEqual(['delivered'])
        const afterFirst = await mine(slowId)
        expect(afterFirst.filter((d) => d.status === 'delivered')).toHaveLength(3)
        // The rest were never claimed: still pending, no attempt, still due.
        const untouched = afterFirst.filter((d) => d.status !== 'delivered')
        expect(untouched).toHaveLength(17)
        for (const d of untouched) {
            expect(d.status).toBe('pending')
            expect(d.attemptCount).toBe(0)
            expect(new Date(d.nextAttemptAt).getTime()).toBeLessThanOrEqual(due.getTime())
        }

        // The next tick, with a row bound this time, takes up where the first left off.
        clock = 0
        const second = await runDueDeliveries(fakeDb, due, dispatch, {
            maxItems: 10,
            deadline: Number.MAX_SAFE_INTEGER,
        })
        expect(second).toEqual({ delivered: 10, failed: 0, dead: 0, deferred: 1, stoppedBy: 'items' })
        const third = await runDueDeliveries(fakeDb, due, dispatch, { maxItems: 10, deadline: Number.MAX_SAFE_INTEGER })
        expect(third).toEqual({ delivered: 7, failed: 0, dead: 0, deferred: 0, stoppedBy: null })

        // All twenty-one delivered, each sent exactly once.
        const all = [...(await mine(slowId)), ...(await mine(quietId))]
        expect(all).toHaveLength(21)
        expect(all.every((d) => d.status === 'delivered' && d.attemptCount === 1)).toBe(true)
        expect(new Set(sent).size).toBe(sent.length)
        expect(sent).toHaveLength(21)
    })

    test('a drain whose deadline has already passed lists nothing and sends nothing', async () => {
        const { fakeDb } = await import('../adapters/fake/db')
        const { runDueDeliveries } = await import('./webhooks')
        const sent: string[] = []
        const result = await runDueDeliveries(
            fakeDb,
            new Date('2030-01-01T00:00:00.000Z'),
            (input) => {
                sent.push(input.deliveryId)
                return { delivered: true }
            },
            { maxItems: 100, deadline: 0, clock: () => 0 },
        )
        expect(result).toEqual({ delivered: 0, failed: 0, dead: 0, deferred: 0, stoppedBy: 'time' })
        expect(sent).toEqual([])
    })
})
