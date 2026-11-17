import { db, isSimulated } from '@sssb/kit/adapters/index'
import { worldNow } from '@sssb/kit/adapters/fake/clock'
import { runDueDeliveries } from '@sssb/kit/db/webhooks'
import { dispatchWebhook } from '@sssb/kit/server-lib/webhook-dispatch'
import { withPortErrors } from '../../../respond'

/**
 * Simulator "deliver due now" (simulated-mode-only; 404 in real): drains due webhook deliveries at the
 * current world clock WITHOUT moving it — the Hooks-tab twin of the schedules "run due now" (advancing
 * the world clock also drains deliveries, so this is the no-move operator override). Exempt from the
 * authorize() scan by the simulator/ simulated-mode gate.
 */
export async function POST(): Promise<Response> {
    if (!isSimulated) return new Response(null, { status: 404 })
    return withPortErrors(async () => {
        const deliveries = await runDueDeliveries(db, worldNow(), dispatchWebhook)
        return Response.json({ ok: true, deliveries })
    })
}
