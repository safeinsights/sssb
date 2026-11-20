import { isSimulated } from '@sssb/kit/adapters/index'
import { restoreSnapshot } from '@sssb/kit/adapters/fake/simulator-admin'
import { refuseNonJson, withPortErrors } from '../../../respond'

/** Same simulated-mode-only gate as the rest of /api/simulator/*; no auth required to call this. Body:
 *  `{ name }`. 404s if the named snapshot doesn't exist (NotFoundError, mapped by withPortErrors). */
export async function POST(request: Request): Promise<Response> {
    if (!isSimulated) return new Response(null, { status: 404 })
    const refused = refuseNonJson(request)
    if (refused) return refused
    return withPortErrors(async () => {
        const { name } = (await request.json()) as { name?: string }
        if (typeof name !== 'string') return Response.json({ error: 'name is required' }, { status: 400 })

        await restoreSnapshot(name)
        return new Response(null, { status: 204 })
    })
}
