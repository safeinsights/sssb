import { PostHog } from 'posthog-node'
import type { AnalyticsPort } from '../../ports/analytics'

/**
 * How long `capture` waits for PostHog before it gives up on the event. The server is a Lambda, frozen once its
 * response is sent, so an event still in the client's queue then may never leave: `capture` therefore sends each event
 * itself and waits for it, but never longer than this, so a PostHog outage costs a response at most this much.
 */
export const CAPTURE_TIMEOUT_MS = 2_000

/**
 * How long a feature-flag read waits for PostHog before it answers the default (safeinsights/sssb#104). The protected
 * layout awaits a flag read on every authenticated render, so a slow PostHog costs every page this much, once: a second
 * is what a page can afford, and shorter than a capture (which no render awaits for its own sake) because a flag read
 * is on the way to the person's page. Without it the client's own bound is ten seconds, with one retry: twenty
 * seconds and more per page in an outage. The client is told the same bound with no retries, so the request is aborted
 * rather than left running, and the adapter holds to it whatever the client does.
 */
export const FLAG_TIMEOUT_MS = 1_000

/**
 * AUTHORED — CUTOVER (`analytics`): typechecked, never run against a real project. Enabled in
 * staging/prod only (ADR-0010): a real deployment without a key gets the no-op (./no-analytics.ts).
 */
export function createRealAnalytics(apiKey: string, host: string): AnalyticsPort {
    const client = new PostHog(apiKey, {
        host,
        flushAt: 1,
        flushInterval: 5_000,
        requestTimeout: CAPTURE_TIMEOUT_MS,
        featureFlagsRequestTimeoutMs: FLAG_TIMEOUT_MS,
        featureFlagsRequestMaxRetries: 0,
    })

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
            // A flag read is never load-bearing: a PostHog outage, or one that outruns FLAG_TIMEOUT_MS, degrades to the
            // default rather than throwing into, or holding up, whatever screen asked (the protected layout reads
            // flags on every authenticated render).
            let timer: ReturnType<typeof setTimeout> | undefined
            const timedOut = new Promise<'timed out'>((resolve) => {
                timer = setTimeout(() => resolve('timed out'), FLAG_TIMEOUT_MS)
            })
            try {
                const read = client.isFeatureEnabled(flag, 'server')
                // Once the bound has passed the read's own answer, or failure, is nobody's: keep a late rejection quiet.
                read.catch(() => undefined)
                const enabled = await Promise.race([read, timedOut])
                return enabled === 'timed out' ? defaultValue : (enabled ?? defaultValue)
            } catch {
                return defaultValue
            } finally {
                clearTimeout(timer)
            }
        },
    }
}
