import { runScheduledTick } from '@sssb/kit/server-lib/scheduled-tick'
import { withWebhookSecret } from '@sssb/kit/service-auth/webhook'

/**
 * The scheduled-work tick (cutover row `scheduled-tick`). A scheduler POSTs here on a fixed cadence with the shared
 * secret in `x-sssb-webhook-secret` (or `Authorization: Bearer`, which a deployment's CloudFront does not pass on); a
 * request without that secret is an opaque 401 before anything runs.
 * The body is ignored and the whole job is SSSB's `runScheduledTick`: drain the due schedules and the due webhook
 * deliveries. The Simulator's Jobs tab runs what is due only when asked, so without this route nothing ticks SSSB's
 * scheduler on its own, in a deployment or in `pnpm dev`.
 *
 * Authorization is the shared-secret guard, and the handler has to BE it: the authorize() scan exempts a
 * `webhooks/` handler (a machine caller, not a user session) only if that verb's export is a call to an imported
 * `withWebhookSecret` (or `withMailgunSignature`), as POST is here.
 */
export const POST = withWebhookSecret(async () => Response.json({ ok: true, ...(await runScheduledTick()) }))
