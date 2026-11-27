import { isSimulated, readSimulatedWorld } from '../../stand-ins'

/**
 * FIXTURE ROUTE — SCANNED, NEVER SERVED. See ../../dockets/route.ts for what this tree is.
 *
 * THIS FILE is the `simulator/` PREFIX exemption applied to a READ: a Simulator panel route that reads the simulated
 * world, 404 in real builds. It reads something (a stand-in), so it passes by the exemption's gate, the
 * `if (!isSimulated)` early return, not because it reads nothing.
 */
export async function GET(): Promise<Response> {
    if (!isSimulated) return new Response(null, { status: 404 })
    return Response.json(await readSimulatedWorld())
}
