import { isSimulated } from '@sssb/kit/adapters/index'
import { LOCALES } from '@sssb/kit/core/locale'
import { WORLD_START_NAME_PATTERN } from '@sssb/kit/core/presets'
import { applyDemoPreset } from '@sssb/kit/server-lib/demo-presets'
import { refuseNonJson, withPortErrors } from '../../respond'

/**
 * Loads a registered demo preset (@sssb/kit/core/presets.ts): resets the world, replays the preset's
 * operations, and signs THIS browser in as the preset's viewpoint. Simulator-mode gate, first line (404
 * in real), no role check — like reset, it must work signed out. Body: `{ name, locale }`; answers the
 * path the glue reloads to: the dashboard when the preset signs someone in, the welcome page otherwise.
 */
export async function POST(request: Request): Promise<Response> {
    if (!isSimulated) return new Response(null, { status: 404 })
    const refused = refuseNonJson(request)
    if (refused) return refused
    return withPortErrors(async () => {
        const { name, locale } = (await request.json()) as { name?: unknown; locale?: unknown }
        // The same name shape a saved snapshot takes, checked at the boundary before the registry is asked.
        if (typeof name !== 'string' || !WORLD_START_NAME_PATTERN.test(name)) {
            return Response.json({ error: 'invalid name' }, { status: 400 })
        }
        if (typeof locale !== 'string' || !(LOCALES as readonly string[]).includes(locale)) {
            return Response.json({ error: 'unknown locale' }, { status: 400 })
        }

        const { signedIn } = await applyDemoPreset(name, { baseUrl: request.url })
        return Response.json({ redirectTo: signedIn ? `/${locale}/dashboard` : `/${locale}` })
    })
}
