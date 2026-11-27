import { db, isSimulated, jobs } from '@sssb/kit/adapters/index'
import { worldNow } from '@sssb/kit/adapters/fake/clock'
import { runDueRetries } from '@sssb/kit/db/jobs'
import { runDueSchedules } from '@sssb/kit/db/schedules'
import { runDueDeliveries } from '@sssb/kit/db/webhooks'
import { dispatchWebhook } from '@sssb/kit/server-lib/webhook-dispatch'
import { refuseNonJson, withPortErrors } from '../../../respond'

/**
 * Simulator "run due now" (simulated-mode-only; 404 in real): drains due schedules AND due webhook
 * deliveries at the current world clock WITHOUT moving it — the manual operator override,
 * the twin of the Jobs tab's "run pending jobs". Exempt from the authorize() scan by the simulator/
 * simulated-mode gate.
 */
export async function POST(request: Request): Promise<Response> {
    if (!isSimulated) return new Response(null, { status: 404 })
    const refused = refuseNonJson(request)
    if (refused) return refused
    return withPortErrors(async () => {
        const now = worldNow()
        const { spawned, failed } = await runDueSchedules(db, jobs, now)
        // Due job retries too: advancing past a failed attempt's delay starts its next attempt.
        const retries = await runDueRetries(db, jobs, now)
        const deliveries = await runDueDeliveries(db, now, dispatchWebhook)
        return Response.json({ ok: true, spawned, failed, retries, deliveries })
    })
}
