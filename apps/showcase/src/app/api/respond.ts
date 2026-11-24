import { InvalidTransitionError } from '@sssb/kit/core/state-machine'
import { AuthRequiredError, DatabaseUnavailableError, ForbiddenError, NotFoundError } from '@sssb/kit/ports/errors'

/**
 * Maps port errors to HTTP for route handlers. A rejected state-machine hop (InvalidTransitionError)
 * becomes 409 `{ error: 'invalid-transition', from, to }` — the SAME body the service wrapper returns
 * (src/app/api/service/respond.ts) — so a product mutation that lost a lifecycle race (e.g. accepting
 * an already-decided escalation, or a PATCH that asks a ticket for a hop its machine forbids) reports
 * it identically.
 */
export async function withPortErrors(fn: () => Promise<Response>): Promise<Response> {
    try {
        return await fn()
    } catch (error) {
        if (error instanceof AuthRequiredError) return Response.json({ error: 'unauthorized' }, { status: 401 })
        if (error instanceof ForbiddenError) return Response.json({ error: 'forbidden' }, { status: 403 })
        if (error instanceof NotFoundError) return Response.json({ error: 'not found' }, { status: 404 })
        if (error instanceof InvalidPayloadError) return Response.json({ error: 'invalid-payload' }, { status: 400 })
        if (error instanceof InvalidTransitionError) {
            return Response.json({ error: 'invalid-transition', from: error.from, to: error.to }, { status: 409 })
        }
        if (error instanceof DatabaseUnavailableError) {
            // It may serve soon (a paused database waking, say): logged, and the client may ask again. Repeat a GET by
            // itself; a write may have happened, so let the person decide.
            console.warn(`database unavailable (${error.reason}): ${error.message}`)
            return Response.json(
                { error: 'database-unavailable', reason: error.reason },
                { status: 503, headers: { 'retry-after': String(error.retryAfterSeconds) } },
            )
        }
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

/** Postgres's own id shape (`gen_random_uuid()`), which every table's id has. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * True when `value` can be a row id. An id that cannot be one is bound to a `uuid` column as a cast
 * error inside the query (a 500, and a probe signal), so routes check the shape first: a path id that is
 * not a uuid is a 404 (no such row; see requireUuidParam), a body id a 400.
 */
export function isUuid(value: unknown): value is string {
    return typeof value === 'string' && UUID_PATTERN.test(value)
}

/** A path segment that must name a row: returned as is when it can be one, otherwise NotFoundError (a 404). */
export function requireUuidParam(id: string): string {
    if (!isUuid(id)) throw new NotFoundError()
    return id
}

/**
 * The json-only guard of a POST another page must not be able to send: 415 `{ error: 'json-only' }` unless the request
 * says `content-type: application/json`, else null. The simulated-mode routes sign a browser in as anyone or change the
 * simulated world, and the sign-out route ends a session. A page on another origin can send a simple POST (text/plain
 * or a form, no preflight), to a developer's localhost, a hosted simulated demo, or from a sibling subdomain with the
 * session cookie. Asking for JSON makes such a browser request preflight, and the preflight fails because nothing here
 * sends `Access-Control-Allow-Origin`. In a simulated-mode route, call it right after the opening simulated-mode 404.
 */
export function refuseNonJson(request: Request): Response | null {
    if (request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null
    return Response.json({ error: 'json-only' }, { status: 415 })
}
