import { auth } from '@sssb/kit/adapters/index'
import { refuseNonJson, withPortErrors } from '../../respond'

/**
 * Ends the session. JSON only (`refuseNonJson`): a plain form POST needs no preflight, so a page on a sibling
 * subdomain, which the browser sends the session cookie with, could otherwise sign a person out with no click. That
 * matters most on an identity-provider instance shared with another product, whose session it may also end.
 */
export async function POST(request: Request): Promise<Response> {
    const refused = refuseNonJson(request)
    if (refused) return refused
    return withPortErrors(async () => {
        await auth.signOut()
        return Response.json({ ok: true })
    })
}
