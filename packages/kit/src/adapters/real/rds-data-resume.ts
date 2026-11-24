import { DatabaseUnavailableError, type DatabaseUnavailableReason } from '../../ports/errors'

/**
 * What the Data API's "the database can't serve this now" errors are, which of them may be retried, and the one wait a
 * process makes while a paused cluster resumes. Pure: no AWS SDK, so ./rds-data-dialect.ts decides by command, and the
 * tests by error name.
 */

/**
 * How long one call waits for a resuming cluster before it fails: 18 seconds, inside SssbApp's 30 s server timeout.
 * AWS puts a typical resume at about 15 s, and measured ones took 12 to 14 s. The measured cold request took 26 s of
 * which the wait was 15, so up to 11 s went elsewhere (the failed calls themselves, a fresh database's first queries):
 * 18 leaves 12. A resume after more than 24 hours paused can take 30 s or longer (AWS's auto-pause page), which no
 * budget inside 30 s covers. docs/runbooks/data-api.md says how to change it.
 */
export const RESUME_BUDGET_MS = 18_000

/**
 * The waits between probes, the last one repeating. One second from the seventh second on: no measured resume was
 * shorter, and a longer step there is what made a resume at 12 s unseen until 15.
 */
const PROBE_DELAYS_MS = [1000, 2000, 4000, 1000] as const

/**
 * How long one probe holds up the next. The SDK's client has no request timeout, so without this a probe on a dead
 * connection (a Lambda frozen with one in flight) would hold every call that joined, with the database up.
 */
const PROBE_TIMEOUT_MS = 2000

/** The Data API's exceptions that mean the database can't serve the call now, by name. */
const REASONS: Readonly<Record<string, DatabaseUnavailableReason>> = {
    DatabaseResumingException: 'resuming',
    ThrottlingException: 'throttled',
    StatementTimeoutException: 'timed-out',
    DatabaseUnavailableException: 'unavailable',
    ServiceUnavailableError: 'unavailable',
}

/**
 * Why the database can't serve a call, read from the error or the first error in its cause chain that says; undefined
 * when the failure is something else. An error about the SQL itself ends the search, so that nothing under it, and no
 * text of its own, makes a failed statement look like a paused database.
 */
export function unavailableReason(error: unknown): DatabaseUnavailableReason | undefined {
    const seen = new Set<unknown>()
    for (let link = error; link instanceof Error && !seen.has(link); link = link.cause) {
        seen.add(link)
        const reason = Object.hasOwn(REASONS, link.name) ? REASONS[link.name] : undefined
        if (reason) return reason
        // "This exception is deprecated" (the API reference), and an older form of the resuming answer. Postgres's own
        // errors, which quote row text, open with ERROR: or state a SQLSTATE.
        if (link.name === 'BadRequestException') {
            const aboutSql = /\bERROR:|SQLState:/.test(link.message)
            return !aboutSql && /\bis resuming\b/i.test(link.message) ? 'resuming' : undefined
        }
        if (link.name === 'DatabaseErrorException') return undefined
    }
    return undefined
}

/** The one failure AWS documents as cancelled, not run. The error itself, never a cause: a wrapper may be a later one. */
export function wasCancelledUnrun(error: unknown): boolean {
    return error instanceof Error && error.name === 'DatabaseResumingException'
}

/** The error an app sees. `cause` is AWS's own error. */
export function unavailable(reason: DatabaseUnavailableReason, error: unknown): DatabaseUnavailableError {
    const detail = error instanceof Error ? error.message : String(error)
    return new DatabaseUnavailableError(reason, `RDS Data API: the database is not available (${reason}): ${detail}`, {
        cause: error,
    })
}

interface Wake {
    readonly ended: Promise<void>
    readonly end: () => void
    waiters: number
    lastError: unknown
    /** The database has said it is resuming, where a wait may also have been started by a throttle. */
    resuming: boolean
}

/**
 * One wait per process for a resuming cluster. The first call that finds it resuming starts a poll of `probe`; every
 * call that joins before the poll ends waits on the same one, each for no longer than its own deadline. The poll ends
 * when the probe answers or fails for another reason (the joined calls then go and get their own answers), or when
 * nobody waits for it any more. A probe that does not answer holds up the next for `PROBE_TIMEOUT_MS`. A poll that has ended, and one nobody waits on, is never joined.
 */
export class ResumeWait {
    #current: Wake | undefined

    /** Must be safe to run any number of times: it is repeated after failures of every kind. */
    private readonly probe: () => Promise<unknown>

    constructor(probe: () => Promise<unknown>) {
        this.probe = probe
    }

    /** A wait is under way for a database that said it is resuming: a call not sent yet would only be refused. */
    get resuming(): boolean {
        return this.#current?.resuming === true
    }

    /** Waits until the database answers; throws DatabaseUnavailableError at `deadline` (a `Date.now()` time). */
    async join(deadline: number, error?: unknown): Promise<void> {
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw this.#expired(error ?? this.#current?.lastError)
        const wake = this.#current ?? this.#start()
        if (error !== undefined) this.#saw(wake, error)
        wake.waiters += 1
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            const expired = await Promise.race([
                wake.ended.then(() => false),
                new Promise<boolean>((resolve) => {
                    timer = setTimeout(() => resolve(true), remaining)
                }),
            ])
            if (expired) throw this.#expired(wake.lastError)
        } finally {
            clearTimeout(timer)
            wake.waiters -= 1
            if (wake.waiters === 0) this.#forget(wake)
        }
    }

    #expired(error: unknown): DatabaseUnavailableError {
        return unavailable(unavailableReason(error) ?? 'resuming', error)
    }

    #saw(wake: Wake, error: unknown): void {
        wake.lastError = error
        if (unavailableReason(error) === 'resuming') wake.resuming = true
    }

    #forget(wake: Wake): void {
        if (this.#current === wake) this.#current = undefined
    }

    #finish(wake: Wake): void {
        this.#forget(wake)
        wake.end()
    }

    #start(): Wake {
        let end: () => void = () => {}
        const ended = new Promise<void>((resolve) => {
            end = resolve
        })
        const wake: Wake = { ended, end, waiters: 0, lastError: undefined, resuming: false }
        this.#current = wake
        void this.#poll(wake).finally(() => this.#finish(wake))
        return wake
    }

    /** Ends when the database answers, or fails a probe for another reason, or nobody waits any more. */
    async #poll(wake: Wake): Promise<void> {
        for (let attempt = 0; ; attempt += 1) {
            await sleep(PROBE_DELAYS_MS[Math.min(attempt, PROBE_DELAYS_MS.length - 1)])
            if (wake.waiters === 0) return
            let over = false
            let inTurn = true
            // Ends the wait also when this probe outlasted its turn and a later one is in flight.
            const finish = (): void => {
                over = true
                this.#finish(wake)
            }
            const probed = Promise.resolve()
                .then(() => this.probe())
                .then(finish, (error: unknown) => {
                    if (!unavailableReason(error)) finish()
                    else if (inTurn) this.#saw(wake, error)
                })
            let timer: ReturnType<typeof setTimeout> | undefined
            await Promise.race([
                probed,
                new Promise((resolve) => {
                    timer = setTimeout(resolve, PROBE_TIMEOUT_MS)
                }),
            ])
            clearTimeout(timer)
            inTurn = false
            if (over) return
        }
    }
}

function sleep(ms: number | undefined): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
