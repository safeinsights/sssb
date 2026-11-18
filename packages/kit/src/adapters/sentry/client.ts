import * as Sentry from '@sentry/nextjs'
import { scrubEvent } from '../../observability/scrub'
import { SENTRY_V10_BASELINE } from './baseline'

/** Browser Sentry init (ADR-0010) — dynamically imported only when a DSN is configured. */
export function initClientSentry(): void {
    Sentry.init({
        dsn: (process.env as { NEXT_PUBLIC_SENTRY_DSN?: string }).NEXT_PUBLIC_SENTRY_DSN,
        tracesSampleRate: 0.1,
        ...SENTRY_V10_BASELINE,
        beforeSend: (event) => scrubEvent(event),
    })
}

export function forwardRouterTransition(href: string, navigationType: string): void {
    Sentry.captureRouterTransitionStart(href, navigationType)
}
