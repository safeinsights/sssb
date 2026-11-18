// @ts-check
// `sssb tick <app>` (an app's `pnpm tick`) — calls the running dev server's scheduled-tick route once and says what ran.
//
// In a deployment an external scheduler POSTs each app's `/api/webhooks/cron` (the `scheduled-tick` cutover row).
// In `pnpm dev` nothing does, so a due digest or a webhook retry sits there until somebody does it by hand. This is
// the by-hand, as one command; `sssb dev-tick` (dev-tick.js) is the same call on a timer, opt-in.
//
// What this is NOT: a way around the route's guard. The route is `withWebhookSecret(...)`, and this sends it the
// per-checkout dev secret (`<app>/.data/auth/webhook-secret`, the file the simulated server generates) as a bearer,
// exactly as an external caller would. It adds nothing to the server: no flag, no header the server honours, no
// route. A server in real mode checks `WEBHOOK_SECRET` instead, never reads that file, and answers this 401.
//
// Run through the package script (`pnpm tick`, `pnpm tick:starter`): the working directory is then the app's, which is
// where the server keeps `.data` (`APP_DATA_DIR` overrides it, for both).
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { portFor } from '../ports.js'

/** The apps that have a tick route. The key is the PORT key (a slot, not the app's name, so it survives a rename of the app). */
export const TICK_APPS = ['showcase', 'starter']

export const TICK_PATH = '/api/webhooks/cron'

/** A cold `next dev` compiles the route on its first hit, so the default is generous. */
export const DEFAULT_TIMEOUT_SECONDS = 60

/** Bounds that keep `AbortSignal.timeout` meaningful: a value that rounds to 0 times out at once, a huge one throws. */
const MIN_TIMEOUT_SECONDS = 0.1
const MAX_TIMEOUT_SECONDS = 3600

const USAGE = `usage: pnpm tick [--url <origin>] [--timeout <seconds>]   (sssb tick also takes --app <dir>)
       (per app: pnpm tick = showcase, pnpm tick:starter = starter; direct: sssb tick <${TICK_APPS.join('|')}> ...)

  --url <origin>       the dev server's origin, loopback only (default: this checkout's port for the app)
  --timeout <seconds>  give up on the request after this long, ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS} (default ${DEFAULT_TIMEOUT_SECONDS})`

/** A failure with a message meant for the person at the terminal. `usage` marks a bad command line, not a bad tick. */
export class TickError extends Error {
    /** @param {string} message @param {{ usage?: boolean }} [options] */
    constructor(message, { usage = false } = {}) {
        super(message)
        this.name = 'TickError'
        this.usage = usage
    }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Loopback only. The bearer is the dev secret and it is sent in the clear, so a URL that is not this machine is
 * refused rather than trusted: there is no flag to point this at a real deployment, whose scheduler is not this.
 *
 * @param {string} value
 * @returns {string} the origin, without a trailing slash
 */
export function parseLoopbackOrigin(value) {
    let url
    try {
        url = new URL(value)
    } catch {
        throw new TickError(`--url must be an origin like http://localhost:3000, got "${value}"`, { usage: true })
    }
    if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
        throw new TickError(
            `--url must be http on localhost, 127.0.0.1 or [::1] (the dev secret is sent as a bearer), got "${value}"`,
            { usage: true },
        )
    }
    return url.origin
}

/**
 * @param {string[]} argv the arguments after the script name
 * @returns {{ app: string, origin: string, timeoutMs: number }}
 */
export function parseTickArgs(argv) {
    /** @type {string | undefined} */
    let app
    /** @type {string | undefined} */
    let url
    let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        const flag = arg.startsWith('--') ? arg.split('=', 1)[0] : null
        if (flag === '--url' || flag === '--timeout') {
            const inline = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined
            const value = inline ?? argv[++i]
            if (value === undefined || value === '' || (inline === undefined && value.startsWith('--'))) {
                throw new TickError(`${flag} needs a value`, { usage: true })
            }
            if (flag === '--url') {
                url = value
            } else {
                const parsed = Number(value)
                if (!Number.isFinite(parsed) || parsed < MIN_TIMEOUT_SECONDS || parsed > MAX_TIMEOUT_SECONDS) {
                    throw new TickError(
                        `--timeout must be between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} seconds, got "${value}"`,
                        { usage: true },
                    )
                }
                timeoutSeconds = parsed
            }
        } else if (arg.startsWith('-')) {
            throw new TickError(`unknown option "${arg}"`, { usage: true })
        } else if (app === undefined) {
            app = arg
        } else {
            throw new TickError(`unexpected argument "${arg}"`, { usage: true })
        }
    }

    if (app === undefined) throw new TickError('which app? the first argument is the app', { usage: true })
    if (!TICK_APPS.includes(app)) {
        throw new TickError(`unknown app "${app}" (known: ${TICK_APPS.join(', ')})`, { usage: true })
    }

    let origin
    if (url !== undefined) {
        origin = parseLoopbackOrigin(url)
    } else {
        try {
            origin = `http://localhost:${portFor(/** @type {'showcase' | 'starter'} */ (app))}`
        } catch (error) {
            throw new TickError(error instanceof Error ? error.message : String(error), { usage: true })
        }
    }
    return { app, origin, timeoutMs: Math.round(timeoutSeconds * 1000) }
}

/**
 * Where the simulated server keeps its inbound-webhook secret: `dataDir('auth')` in the kit
 * (`APP_DATA_DIR`, else `.data` under the app's working directory) plus `webhook-secret`.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [cwd]
 */
export function secretFilePath(env = process.env, cwd = process.cwd()) {
    return path.join(env.APP_DATA_DIR ?? path.join(cwd, '.data'), 'auth', 'webhook-secret')
}

/**
 * @param {unknown} error
 * @param {string} endpoint
 */
function unreachable(error, endpoint) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error
    const code = cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : null
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        return new TickError(`no answer from ${endpoint} before the timeout`)
    }
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') {
        return new TickError(`could not reach ${endpoint} (${code}) — is the dev server running? (\`pnpm dev\`)`)
    }
    return new TickError(`request to ${endpoint} failed: ${error instanceof Error ? error.message : String(error)}`)
}

/**
 * One tick. Resolves to the route's JSON body; rejects with a `TickError` for anything that is not a 2xx.
 *
 * The first request to a checkout's server is what creates its secret file, so with none on disk yet one request
 * goes out with a throwaway bearer (a 401, by design) to make the server write it, then the real one follows.
 *
 * `signal` ends a tick early (the dev ticker passes the one that stops it, so a tick in flight does not outlive the
 * server it was for).
 *
 * @param {{ origin: string, timeoutMs: number, secretFile?: string, fetchImpl?: typeof fetch, signal?: AbortSignal }} options
 * @returns {Promise<Record<string, unknown>>}
 */
export async function tickOnce({ origin, timeoutMs, secretFile = secretFilePath(), fetchImpl = fetch, signal }) {
    const endpoint = `${origin}${TICK_PATH}`
    /** @param {string} bearer */
    const post = async (bearer) => {
        try {
            return await fetchImpl(endpoint, {
                method: 'POST',
                headers: { authorization: `Bearer ${bearer}` },
                signal: signal
                    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
                    : AbortSignal.timeout(timeoutMs),
            })
        } catch (error) {
            throw unreachable(error, endpoint)
        }
    }

    if (!existsSync(secretFile)) {
        const probe = await post('x')
        await probe.body?.cancel()
        if (!existsSync(secretFile)) {
            throw new TickError(
                `the server at ${origin} did not create a dev secret at ${secretFile}. Is it a simulated-mode dev server ` +
                    `(\`pnpm dev\`, not \`dev:real\`), and is this the app's own directory (APP_DATA_DIR unset or matching)?`,
            )
        }
    }

    /** @type {string} */
    let secret
    try {
        secret = readFileSync(secretFile, 'utf8')
    } catch (error) {
        throw new TickError(
            `could not read the dev secret at ${secretFile}: ${error instanceof Error ? error.message : String(error)}`,
        )
    }
    const response = await post(secret)
    const text = await response.text()
    if (response.status === 401) {
        throw new TickError(
            `${endpoint} answered 401: the server did not accept the secret in ${secretFile}. A server in real mode checks ` +
                `WEBHOOK_SECRET, not this file; a server started from another checkout or data dir has its own secret.`,
        )
    }
    if (!response.ok) throw new TickError(`${endpoint} answered ${response.status}: ${text.slice(0, 300)}`)
    try {
        const body = JSON.parse(text)
        if (body && typeof body === 'object' && !Array.isArray(body)) return body
    } catch {
        // fall through to the same message as a non-object body
    }
    throw new TickError(
        `${endpoint} answered ${response.status} with a body that is not the tick's JSON: ${text.slice(0, 300)}`,
    )
}

/** @param {unknown} value */
function count(value) {
    return typeof value === 'number' ? value : 0
}

/**
 * What a tick did, in one line. `failed` is a schedule whose spawn failed (the next tick retries it) and a delivery
 * that failed or died: shown, but it is the tick reporting work that went wrong, not the tick failing.
 *
 * @param {Record<string, unknown>} body the route's JSON: `{ ok, spawned, failed, deliveries: { delivered, failed, dead } }`
 */
export function summarizeTick(body) {
    const deliveries =
        body.deliveries && typeof body.deliveries === 'object'
            ? /** @type {Record<string, unknown>} */ (body.deliveries)
            : {}
    return (
        `ticked: ${count(body.spawned)} job(s) spawned from due schedules, ${count(body.failed)} schedule(s) failed; ` +
        `webhook deliveries: ${count(deliveries.delivered)} delivered, ${count(deliveries.failed)} failed, ${count(deliveries.dead)} dead`
    )
}

/**
 * Whether a tick moved anything at all, for a caller that only wants to speak when something happened.
 *
 * @param {Record<string, unknown>} body
 */
export function tickDidWork(body) {
    const deliveries =
        body.deliveries && typeof body.deliveries === 'object'
            ? /** @type {Record<string, unknown>} */ (body.deliveries)
            : {}
    return [body.spawned, body.failed, deliveries.delivered, deliveries.failed, deliveries.dead].some(
        (n) => count(n) > 0,
    )
}

/** @param {string[]} argv */
export async function main(argv) {
    try {
        const { origin, timeoutMs } = parseTickArgs(argv)
        const body = await tickOnce({ origin, timeoutMs })
        console.log(summarizeTick(body))
        return 0
    } catch (error) {
        if (!(error instanceof TickError)) throw error
        console.error(`tick: ${error.message}`)
        if (error.usage) console.error(USAGE)
        return error.usage ? 2 : 1
    }
}
