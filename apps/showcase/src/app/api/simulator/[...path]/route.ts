import { isSimulated } from '@sssb/kit/adapters/index'
import type { SimulatorRouteContext } from '@sssb/kit/server-lib/simulator-api'

/**
 * The Simulator panel's server side: every `/api/simulator/<path>` call the panel makes lands here and is answered by
 * SSSB's `simulatorApi`, every framework tab included. This app's own route files beside it win for their paths (Next
 * routes a static segment before a catch-all): the dev ticker (`ticker`), and what the Actors tab's drivers call
 * (`actors/*`, `service-token`, `webhook-secret`), which SSSB's host does not serve (safeinsights/sssb#152).
 *
 * Each handler opens with the simulated-mode 404 and loads SSSB's handler only after it, so a real build never loads
 * it. That first line is also the gate the authorization scan checks: these handlers are exempt from `authorize(...)`
 * as a simulated-world surface, and only while each one opens with it.
 */
export async function GET(request: Request, context: SimulatorRouteContext): Promise<Response> {
    if (!isSimulated) return new Response(null, { status: 404 })
    const { simulatorApi } = await import('@sssb/kit/server-lib/simulator-api')
    return simulatorApi(request, context)
}

export async function POST(request: Request, context: SimulatorRouteContext): Promise<Response> {
    if (!isSimulated) return new Response(null, { status: 404 })
    const { simulatorApi } = await import('@sssb/kit/server-lib/simulator-api')
    return simulatorApi(request, context)
}
