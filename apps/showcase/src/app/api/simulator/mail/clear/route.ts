import { isSimulated } from '@sssb/kit/adapters/index'
import { clearCaughtEmails } from '@sssb/kit/adapters/fake/email'
import { refuseNonJson, withPortErrors } from '../../../respond'

/** Empties the fake email catch store (.data/emails) so long dev sessions stay legible without a
 *  full world reset. Same simulated-mode-only gate as the rest of /api/simulator/*; no auth required. */
export async function POST(request: Request): Promise<Response> {
    if (!isSimulated) return new Response(null, { status: 404 })
    const refused = refuseNonJson(request)
    if (refused) return refused
    return withPortErrors(async () => {
        clearCaughtEmails()
        return new Response(null, { status: 204 })
    })
}
