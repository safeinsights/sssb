import { auth } from '@sssb/kit/adapters/index'
import { readJsonObject, withPortErrors } from '../../respond'

export async function POST(request: Request): Promise<Response> {
    return withPortErrors(async () => {
        // Signed in first: a signed-out caller hears 401, never a 400 about a body it had no right to send.
        await auth.requireUser()
        const { orgSlug } = await readJsonObject(request)
        if (typeof orgSlug !== 'string' || !orgSlug) return Response.json({ error: 'invalid-payload' }, { status: 400 })
        await auth.setActiveOrg(orgSlug)
        return Response.json({ ok: true })
    })
}
