import type { AnalyticsPort } from '../../ports/analytics'

/**
 * Analytics in a real deployment that configures no PostHog key (ADR-0010 enables PostHog in staging and production
 * only). It captures nothing, and every flag answers the default its caller declares, as the PostHog adapter does when
 * PostHog cannot be reached (./analytics.ts): a flag read is never load-bearing.
 *
 * Never the simulated world's fake (../fake/analytics.ts), which writes each capture and reads each flag under `.data/`
 * in the working directory. On Lambda that directory is the deployment package, which is read-only, so the fake threw
 * into whatever called it there: sending an invite awaits a capture.
 */
export const noAnalytics: AnalyticsPort = {
    async capture() {},
    async isFlagEnabled(_flag, defaultValue = false) {
        return defaultValue
    },
}
