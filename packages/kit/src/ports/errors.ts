/** Thrown by requireUser/requireRole when no one is signed in. Route glue turns this into a redirect. */
export class AuthRequiredError extends Error {
    constructor() {
        super('authentication required')
        this.name = 'AuthRequiredError'
    }
}

/** Thrown by requireRole when the signed-in user lacks the required role. */
export class ForbiddenError extends Error {
    constructor(message = 'forbidden') {
        super(message)
        this.name = 'ForbiddenError'
    }
}

/** Thrown when a referenced resource doesn't exist (e.g. an unknown Snapshots snapshot name). Route
 *  glue turns this into a 404, distinct from ForbiddenError's 403 (bad input vs. missing thing). */
export class NotFoundError extends Error {
    constructor(message = 'not found') {
        super(message)
        this.name = 'NotFoundError'
    }
}

/** Thrown when a precondition the caller supplied no longer holds: a storage `copy` whose `ifMatch` names a
 *  version of the source that has since changed. The caller read something, decided, and the thing moved, so
 *  it should read again rather than retry. No route glue maps it (`withPortErrors` rethrows it, so
 *  it becomes a 500): a route that passes `ifMatch` catches it and answers a 409 or a 412. */
export class PreconditionFailedError extends Error {
    constructor(message = 'precondition failed') {
        super(message)
        this.name = 'PreconditionFailedError'
    }
}

/**
 * Why the database can't serve a call now. `resuming`: a paused cluster is starting. `throttled`: it refused the call
 * for load, as it may while a cluster resumes. `timed-out`: a statement ran past the transport's limit. `unavailable`:
 * the writer or the database service is not available.
 */
export type DatabaseUnavailableReason = 'resuming' | 'throttled' | 'timed-out' | 'unavailable'

/**
 * Thrown when the database can't serve a call now and may soon: a paused cluster that outlasted the transport's wait,
 * a throttled or timed-out call, a writer or a database service that is not available. On the RDS Data API a few
 * answers that the database is resuming throw it at once, as `resuming`, without a wait: to a commit, whose outcome is
 * then unknown, so never assume that it failed; to a statement after another has succeeded in its transaction; and to
 * a statement as a `BadRequestException`. Route glue answers a 503 with `Retry-After: retryAfterSeconds`. It does not
 * say the work did not happen: treat a throttled or timed-out statement or commit as if it may have run. So a caller
 * repeats a read by itself, and a write only when a person, or an idempotent request, asks for it again. `cause` is
 * the vendor's error. Raised by the RDS Data API transport; `pg` has no equivalent today.
 */
export class DatabaseUnavailableError extends Error {
    readonly reason: DatabaseUnavailableReason
    readonly retryAfterSeconds = 5

    constructor(reason: DatabaseUnavailableReason, message = 'database unavailable', options?: { cause?: unknown }) {
        super(message, options)
        this.name = 'DatabaseUnavailableError'
        this.reason = reason
    }
}

/** Thrown by real adapters when their cutover items are unfilled (fail-fast for dev:real). */
export class CutoverPendingError extends Error {
    readonly cutoverItems: string[]

    constructor(cutoverItems: string[], detail: string) {
        super(`real adapters unavailable — open cutover items: ${cutoverItems.join(', ')}. ${detail}`)
        this.cutoverItems = cutoverItems
        this.name = 'CutoverPendingError'
    }
}
