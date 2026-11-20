import { devSignIn } from '@sssb/kit/adapters/fake/auth'
import { isSimulated } from '@sssb/kit/adapters/index'
import { refuseNonJson, withPortErrors } from '../../respond'

export async function POST(request: Request): Promise<Response> {
    if (!isSimulated) return Response.json({ error: 'not found' }, { status: 404 })
    const refused = refuseNonJson(request)
    if (refused) return refused
    return withPortErrors(async () => {
        const { personId } = (await request.json()) as { personId: string }
        await devSignIn(personId)
        return Response.json({ ok: true })
    })
}
