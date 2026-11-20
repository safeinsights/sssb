import { devSignIn } from '@sssb/kit/adapters/fake/auth'
import { isSimulated } from '@sssb/kit/adapters/index'
import { readJsonObject, refuseNonJson, withPortErrors } from '../../respond'

export async function POST(request: Request): Promise<Response> {
    if (!isSimulated) return Response.json({ error: 'not found' }, { status: 404 })
    const refused = refuseNonJson(request)
    if (refused) return refused
    return withPortErrors(async () => {
        const { personId } = await readJsonObject(request)
        if (typeof personId !== 'string' || !personId)
            return Response.json({ error: 'invalid-payload' }, { status: 400 })
        await devSignIn(personId)
        return Response.json({ ok: true })
    })
}
