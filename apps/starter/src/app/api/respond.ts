import { AuthRequiredError, ForbiddenError, NotFoundError } from '@sssb/kit/ports/errors'

/** Maps port errors to HTTP for this app's route handlers. */
export async function withPortErrors(fn: () => Promise<Response>): Promise<Response> {
    try {
        return await fn()
    } catch (error) {
        if (error instanceof AuthRequiredError) return Response.json({ error: 'unauthorized' }, { status: 401 })
        if (error instanceof ForbiddenError) return Response.json({ error: 'forbidden' }, { status: 403 })
        if (error instanceof NotFoundError) return Response.json({ error: 'not found' }, { status: 404 })
        if (error instanceof InvalidPayloadError) return Response.json({ error: 'invalid-payload' }, { status: 400 })
        throw error
    }
}

/** A request body that is not what the route reads: answered 400 `{ error: 'invalid-payload' }` by withPortErrors. */
class InvalidPayloadError extends Error {
    constructor() {
        super('invalid-payload')
        this.name = 'InvalidPayloadError'
    }
}

/**
 * The request's JSON body as a plain object, or InvalidPayloadError (a 400): a body that does not parse,
 * or parses to `null`, an array or a scalar, is the client's mistake, never a 500. Its fields are still
 * `unknown`: check each one's type before using it.
 */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
    let body: unknown
    try {
        body = await request.json()
    } catch {
        throw new InvalidPayloadError()
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new InvalidPayloadError()
    return body as Record<string, unknown>
}

/**
 * The json-only guard of a simulated-mode-only POST: 415 `{ error: 'json-only' }` unless the request says
 * `content-type: application/json`, else null. These routes sign a browser in as anyone or change the simulated world,
 * and a page on another origin can send a simple POST (text/plain or a form, no preflight) to a developer's localhost
 * or a hosted simulated demo. Asking for JSON makes such a browser request preflight, and the preflight fails because
 * nothing here sends `Access-Control-Allow-Origin`. Call it right after the handler's opening simulated-mode 404.
 */
export function refuseNonJson(request: Request): Response | null {
    if (request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null
    return Response.json({ error: 'json-only' }, { status: 415 })
}
