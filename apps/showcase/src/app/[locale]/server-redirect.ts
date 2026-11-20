import { sameOriginPath } from '@sssb/kit/core/same-origin-path'

/**
 * Where a Simulator route's answer says to go, as a path on this origin, or null. The viewpoint and preset routes
 * answer `{ redirectTo }` and only ever name a path here; this is the client's own check, as the kit's simulator host
 * makes on the same answers, so a body naming anything else (`//host`, `/\host`, an absolute URL) is not followed.
 */
export function serverRedirectPath(body: unknown): string | null {
    if (typeof body !== 'object' || body === null) return null
    return sameOriginPath((body as { redirectTo?: unknown }).redirectTo)
}
