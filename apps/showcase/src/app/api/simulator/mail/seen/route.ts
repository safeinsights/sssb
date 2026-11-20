import { isSimulated } from '@sssb/kit/adapters/index'
import { findInvite, listAllPeople } from '@sssb/kit/adapters/fake/auth'
import { updatePersonState, type PersonKey } from '@sssb/kit/adapters/fake/simulator'
import { refuseNonJson, withPortErrors } from '../../../respond'

/** Same simulated-mode-only gate as the rest of /api/simulator/*; no auth required to call this. */
export async function POST(request: Request): Promise<Response> {
    if (!isSimulated) return new Response(null, { status: 404 })
    const refused = refuseNonJson(request)
    if (refused) return refused
    return withPortErrors(async () => {
        const { person } = (await request.json()) as { person?: string }
        if (typeof person !== 'string' || !(person.startsWith('person:') || person.startsWith('invited:'))) {
            return Response.json({ error: 'unsupported person key' }, { status: 400 })
        }

        // Only someone in the world: the key is written to the state file every poll reads.
        const known = person.startsWith('person:')
            ? listAllPeople().some((p) => p.id === person.slice('person:'.length))
            : findInvite(person.slice('invited:'.length)) !== undefined
        if (!known) return Response.json({ error: 'unknown person' }, { status: 400 })

        updatePersonState(person as PersonKey, { mailSeenAt: new Date().toISOString() })
        return Response.json({ ok: true })
    })
}
