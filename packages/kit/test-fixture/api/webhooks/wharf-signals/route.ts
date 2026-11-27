import { withStandardWebhookSignature } from '../../stand-ins'

/**
 * FIXTURE ROUTE — SCANNED, NEVER SERVED. See ../../dockets/route.ts for what this tree is.
 *
 * The `webhooks/` exemption's third gate: a sender that signs Standard Webhooks, verified by
 * `withStandardWebhookSignature` (@sssb/kit/service-auth/standard-webhooks) WRAPPING the handler, as
 * ../jobs/route.ts is wrapped by `withWebhookSecret`. Its stand-in is imported from ../../stand-ins.ts.
 */
export const POST = withStandardWebhookSignature(async ({ webhook }) => Response.json({ received: webhook.id }), {
    secretEnv: 'WHARF_SIGNALS_SECRET',
})
