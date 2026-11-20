import { isSimulated } from '@sssb/kit/adapters/index'
import { bumpWorldAgreement } from '@sssb/kit/adapters/fake/agreements'
import { refuseNonJson, withPortErrors } from '../../../respond'

/**
 * Bump one agreement's version (the demo story: re-arms the gate for everyone with a stale acceptance).
 * Simulated-mode-only Simulator god op (404 first line in real mode). No authorize(): the authorized-mutations
 * scanner exempts `@sssb/kit/` on the `!isSimulated` first-line gate — this is a simulated-world control,
 * never a product mutation path.
 */
export async function POST(request: Request): Promise<Response> {
    if (!isSimulated) return new Response(null, { status: 404 })
    const refused = refuseNonJson(request)
    if (refused) return refused
    return withPortErrors(async () => {
        const { agreementId } = (await request.json()) as { agreementId?: unknown }
        if (typeof agreementId !== 'string' || !agreementId) {
            return Response.json({ error: 'invalid-agreement' }, { status: 400 })
        }
        const result = await bumpWorldAgreement(agreementId)
        if (!result) return Response.json({ error: 'unknown agreement' }, { status: 404 })
        return Response.json({ version: result.version })
    })
}
