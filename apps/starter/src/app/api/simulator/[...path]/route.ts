import { isSimulated } from '@sssb/kit/adapters/index'
import type { SimulatorRouteContext } from '@sssb/kit/server-lib/simulator-api'

/**
 * The Simulator panel's server side on this app's own `pnpm dev`: every `/api/simulator/<path>` call the panel makes
 * lands here and is answered by SSSB's `simulatorApi` (People, Mail, and Jobs with the world clock). A route file of
 * this app's own beside it, `api/simulator/<name>/route.ts`, still wins for its path.
 *
 * Each handler opens with the simulated-mode 404 and loads SSSB's handler only after it, so a real build never loads
 * it. That first line is also the gate the authorization scan checks: these handlers are
 * exempt from `authorize(...)` as a simulated-world surface, and only while each one opens with it.
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
