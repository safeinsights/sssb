import { PostHog } from 'posthog-node'
import type { AnalyticsPort } from '../../ports/analytics'

/**
 * How long `capture` waits for PostHog before it gives up on the event. The server is a Lambda, frozen once its
 * response is sent, so an event still in the client's queue then may never leave: `capture` therefore sends each event
 * itself and waits for it, but never longer than this, so a PostHog outage costs a response at most this much.
 */
export const CAPTURE_TIMEOUT_MS = 2_000

/**
 * AUTHORED — CUTOVER (`analytics`): typechecked, never run against a real project. Enabled in
 * staging/prod only (ADR-0010): a real deployment without a key gets the no-op (./no-analytics.ts).
 */
export function createRealAnalytics(apiKey: string, host: string): AnalyticsPort {
    const client = new PostHog(apiKey, { host, flushAt: 1, flushInterval: 5_000, requestTimeout: CAPTURE_TIMEOUT_MS })

    return {
        // An event is never load-bearing either: a send that fails or outruns CAPTURE_TIMEOUT_MS is logged and dropped.
        async capture(event, properties, distinctId = 'server') {
            let timer: ReturnType<typeof setTimeout> | undefined
            const timedOut = new Promise<'timed out'>((resolve) => {
                timer = setTimeout(() => resolve('timed out'), CAPTURE_TIMEOUT_MS)
            })
            try {
                const sent = client.captureImmediate({
                    distinctId,
                    event,
                    ...(properties === undefined ? {} : { properties }),
                })
                if ((await Promise.race([sent.then(() => 'sent' as const), timedOut])) === 'timed out') {
                    console.warn(`SSSB analytics: dropped event ${event}: PostHog did not answer in time`)
                }
            } catch (error) {
                console.warn(
                    `SSSB analytics: dropped event ${event}: ${error instanceof Error ? error.message : String(error)}`,
                )
            } finally {
                clearTimeout(timer)
            }
        },

        async isFlagEnabled(flag, defaultValue = false) {
            // A flag read is never load-bearing: a PostHog outage degrades to the default rather
            // than throwing into whatever screen asked (the protected layout reads flags on every
            // authenticated render).
            try {
                const enabled = await client.isFeatureEnabled(flag, 'server')
                return enabled ?? defaultValue
            } catch {
                return defaultValue
            }
        },
    }
}
