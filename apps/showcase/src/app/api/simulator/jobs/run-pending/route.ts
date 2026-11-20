import { isSimulated } from '@sssb/kit/adapters/index'
import { runPendingJobs } from '@sssb/kit/adapters/fake/jobs'
import { refuseNonJson, withPortErrors } from '../../../respond'

/**
 * Simulator-mode gate, not a role gate (design invariant): 404s outside simulated mode, first line, no
 * role check. The operator's "step the held world forward" action — runs every currently-queued job
 * across all tenants regardless of the 'jobs-held' knob and reports how many ran.
 */
export async function POST(request: Request): Promise<Response> {
    if (!isSimulated) return new Response(null, { status: 404 })
    const refused = refuseNonJson(request)
    if (refused) return refused
    return withPortErrors(async () => {
        const ran = await runPendingJobs()
        return Response.json({ ran })
    })
}
