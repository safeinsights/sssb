import { auth } from '@sssb/kit/adapters/index'
import { LOCALES, type Locale } from '@sssb/kit/core/locale'
import { readJsonObject, withPortErrors } from '../respond'

/**
 * The longest display name the route accepts: the auth port's own limit (256 characters, as both of SSSB's auth
 * adapters and its ProfileScreen enforce), so the screen, the route and the port agree on one number.
 */
const MAX_NAME_LENGTH = 256

/**
 * Updates the caller's own display name and/or locale. The name is validated here, at the boundary: it
 * is rendered on pages every member of the org opens, so a value that is not a short string (an object,
 * an empty or a megabyte-long name) would break those pages for everyone, and in real mode would go to
 * the auth provider as is. An absent name leaves it unchanged; an unknown locale is ignored.
 */
export async function POST(request: Request): Promise<Response> {
    return withPortErrors(async () => {
        // Signed in first: a signed-out caller hears 401, never a 400 about a body it had no right to send.
        await auth.requireUser()
        const body = await readJsonObject(request)
        let name: string | undefined
        if (body.name !== undefined) {
            name = typeof body.name === 'string' ? body.name.trim() : ''
            if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
                return Response.json({ error: 'invalid-name' }, { status: 400 })
            }
        }
        const locale =
            typeof body.locale === 'string' && LOCALES.includes(body.locale as Locale)
                ? (body.locale as Locale)
                : undefined
        const user = await auth.updateProfile({ name, locale })
        return Response.json({ user })
    })
}
