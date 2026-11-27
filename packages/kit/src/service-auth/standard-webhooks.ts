import { createHmac, timingSafeEqual } from 'node:crypto'
import { isSimulated } from '../adapters/index'
import { devWebhookSecret } from '../adapters/fake/service-auth'
import { WEBHOOK_REPLAY_TOLERANCE_MS } from '../core/webhook-hmac'
import { AuthRequiredError } from '../ports/errors'
import { serverSecretEnvName } from './secret-env'

/**
 * Standard Webhooks inbound verification (https://www.standardwebhooks.com, the scheme Svix signs with): the
 * RECEIVING half for a sender that signs `{id}.{timestamp}.{body}` with HMAC-SHA256 under a shared `whsec_…` secret
 * and sends the result as `v1,<base64>` in `webhook-signature`, beside `webhook-id` and `webhook-timestamp`. A Svix
 * sender's `svix-id`, `svix-timestamp` and `svix-signature` are the same scheme under its older names, and are read
 * when no `webhook-*` header is present. It sits beside the shared-secret verifier (./webhook.ts) and the Mailgun one
 * (./mailgun.ts), in their shape: simulated mode verifies against the per-checkout dev secret, real mode against the
 * environment.
 *
 * WHAT A REQUEST MUST CARRY to pass: all three headers of one family; a timestamp of whole Unix seconds within
 * `toleranceMs` (5 minutes by default) of the server's clock, in either direction; and at least one `v1` signature
 * equal, compared in constant time, to the HMAC of the exact body bytes under one of the configured secrets. Anything
 * else is the same opaque AuthRequiredError (a 401 from the wrapper), whichever check refused it.
 *
 * SECRETS AND ROTATION. A secret is the sender's value as it gives it: `whsec_` and the base64 of the key (the prefix
 * is optional; a value that is not base64 never verifies). `secretEnv` names one variable or several, and each
 * variable may hold several secrets separated by whitespace; a signature made with any of them passes. So a rotation
 * adds the new secret beside the old (`PARTNER_WEBHOOK_SECRET="whsec_new whsec_old"`, or a second variable), waits
 * for the sender to switch, and removes the old one. A sender mid-rotation may itself send several signatures,
 * space-separated, one per secret it holds; any one matching is enough. A variable that is unset or empty contributes
 * nothing, and when none of them holds a secret every request is refused.
 *
 * REPLAY. The timestamp window is the stateless guard: a captured request stops verifying once it is older than the
 * tolerance, and the sender cannot be impersonated with a fresh timestamp without the secret. Inside the window the
 * replay store refuses a second request with the same id AND timestamp, which is what a replay is: the same signed
 * message sent again. A sender's RETRY is not one: Standard Webhooks senders re-sign each attempt with a new
 * timestamp, so a retry passes, and the handler must treat `webhook.id` as the idempotency key the spec says it is
 * (a delivery it already processed is answered 2xx, not processed twice). The default store is an in-process Map,
 * as Mailgun's token guard is: a deployment that runs several server instances needs a shared one
 * (`replayStore`, a small table keyed by the claim key) to make the guard global. When the handler throws or answers
 * 5xx the claim is released, so a sender that resends the very same message after a failure is processed, not
 * refused. Like the other verifiers this ships in REAL builds; never add `runtime = 'edge'` upstream (node:crypto).
 *
 * THE SIGNED STRING'S SEPARATOR. `{id}.{timestamp}.{body}` is not unambiguous when an id contains a dot, a property of
 * the scheme, not of this code: a signed message whose body begins with digits and a dot could be re-presented with a
 * longer id and a different timestamp. The timestamp must still be a fresh one, so the body would have to begin with
 * a current Unix time and a dot. A Standard Webhooks payload is a JSON object, which begins with `{`, so it cannot.
 */

/** The Standard Webhooks header names. */
const STANDARD_WEBHOOK_HEADERS = {
    id: 'webhook-id',
    timestamp: 'webhook-timestamp',
    signature: 'webhook-signature',
} as const

/** The same headers as a Svix sender names them, read when no `webhook-*` header is present. */
const SVIX_WEBHOOK_HEADERS = { id: 'svix-id', timestamp: 'svix-timestamp', signature: 'svix-signature' } as const

/**
 * Where verified messages are remembered until their window closes, so the same signed message is not accepted
 * twice. `claim` records `key` until `expiresAtMs` and answers false when it is already held (and has not expired);
 * `release` forgets it. A store judges expiry by its own clock: `expiresAtMs` already runs a minute past the moment the
 * signature stops verifying, to cover the store's latency and its clock's skew from the server's. The default is
 * per-process; a multi-instance deployment passes a shared one.
 */
export interface StandardWebhookReplayStore {
    claim(key: string, expiresAtMs: number): boolean | Promise<boolean>
    release(key: string): void | Promise<void>
}

export interface StandardWebhookOptions {
    /**
     * The environment variable, or variables, that hold the sender's secret in real mode (see the module header for
     * several secrets and rotation). Required: each sender has its own secret, so there is no default name. These are
     * yours to set in the deployment; SSSB's real-environment checks (`assertRealEnv`, `sssb check-real-env`) do not
     * know them. Simulated mode ignores them and uses the per-checkout dev secret.
     */
    secretEnv: string | readonly string[]
    /** How far the signed timestamp may be from the server's clock, either way. Default 5 minutes. */
    toleranceMs?: number
    /** Where verified messages are remembered (StandardWebhookReplayStore). Default: in-process. */
    replayStore?: StandardWebhookReplayStore
}

/** What a verified request carried: the message id (the idempotency key), its timestamp and its raw body. */
export interface VerifiedStandardWebhook {
    id: string
    /** Unix seconds, as signed. */
    timestamp: number
    body: string
}

export type StandardWebhookVerifyResult = { ok: true } | { ok: false; reason: 'malformed' | 'stale' | 'signature' }

const SECRET_PREFIX = 'whsec_'
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
/** Whole seconds; 15 digits keeps it an exact integer in a double. */
const UNIX_SECONDS = /^\d{1,15}$/
const encoder = new TextEncoder()

/**
 * The shortest key accepted, in bytes. The specification recommends 24 to 64; 16 (128 bits) is the floor below which a
 * guessable value (`changeme` is six bytes of valid base64) would pass for a secret.
 */
const MIN_KEY_BYTES = 16

/** The HMAC key a `whsec_…` secret carries, or null when it is not one, or is shorter than MIN_KEY_BYTES. */
function secretKey(secret: string): Buffer | null {
    const encoded = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret
    if (!BASE64.test(encoded)) return null
    const key = Buffer.from(encoded, 'base64')
    return key.length >= MIN_KEY_BYTES ? key : null
}

function bodyBytes(body: string | Uint8Array): Uint8Array {
    return typeof body === 'string' ? encoder.encode(body) : body
}

function hmac(key: Buffer, id: string, timestamp: string, body: Uint8Array): Buffer {
    return createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body).digest()
}

/**
 * The `webhook-signature` value a sender with `secret` sends for this message: `v1,<base64>`. For a test, a fixture, or
 * an app that sends Standard Webhooks itself. Throws a TypeError for a secret that is not `whsec_`-and-base64.
 */
export function signStandardWebhook(
    secret: string,
    id: string,
    timestampSec: number,
    body: string | Uint8Array,
): string {
    const key = secretKey(secret)
    if (!key)
        throw new TypeError(`a Standard Webhooks secret is whsec_ and the base64 of a key of ${MIN_KEY_BYTES}+ bytes`)
    return `v1,${hmac(key, id, String(timestampSec), bodyBytes(body)).toString('base64')}`
}

/**
 * The pure check, no replay state: the fields are present and the timestamp is whole seconds (`malformed`), within
 * `toleranceMs` of `now` either way (`stale`), and some `v1` signature in the space-separated `signature` list equals
 * the HMAC under some secret in `secrets`, compared in constant time (`signature`). A secret that is not
 * `whsec_`-and-base64 of at least 16 bytes matches nothing. A `toleranceMs` that is not positive and finite throws a
 * TypeError. Signatures of another version (`v1a`, asymmetric) are ignored, never accepted.
 */
export function verifyStandardWebhookSignature(params: {
    id: string | null | undefined
    timestamp: string | null | undefined
    signature: string | null | undefined
    body: string | Uint8Array
    secrets: readonly string[]
    toleranceMs?: number
    now?: Date
}): StandardWebhookVerifyResult {
    const { id, timestamp, signature } = params
    if (!id || !timestamp || !signature || !UNIX_SECONDS.test(timestamp)) return { ok: false, reason: 'malformed' }

    const nowMs = params.now?.getTime() ?? Date.now()
    const toleranceMs = toleranceOf(params)
    if (Math.abs(nowMs - Number(timestamp) * 1000) > toleranceMs) return { ok: false, reason: 'stale' }

    const presented: Buffer[] = []
    for (const entry of signature.split(' ')) {
        const comma = entry.indexOf(',')
        if (comma < 0 || entry.slice(0, comma) !== 'v1') continue
        const encoded = entry.slice(comma + 1)
        if (BASE64.test(encoded)) presented.push(Buffer.from(encoded, 'base64'))
    }
    if (presented.length === 0) return { ok: false, reason: 'malformed' }

    const body = bodyBytes(params.body)
    let matched = false
    for (const secret of params.secrets) {
        const key = secretKey(secret)
        if (!key) continue
        const expected = hmac(key, id, timestamp, body)
        for (const candidate of presented) {
            if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) matched = true
        }
    }
    return matched ? { ok: true } : { ok: false, reason: 'signature' }
}

/** The tolerance, checked: a NaN or infinite one would turn the freshness check off. */
function toleranceOf(options: { toleranceMs?: number | undefined }): number {
    const toleranceMs = options.toleranceMs ?? WEBHOOK_REPLAY_TOLERANCE_MS
    if (!Number.isFinite(toleranceMs) || toleranceMs <= 0) {
        throw new TypeError(`toleranceMs must be a positive, finite number of milliseconds, got ${toleranceMs}`)
    }
    return toleranceMs
}

/** The env var names `options.secretEnv` gives, each checked (./secret-env.ts); at least one. Checks the tolerance too. */
function secretEnvNames(options: StandardWebhookOptions): readonly string[] {
    toleranceOf(options)
    const names = typeof options.secretEnv === 'string' ? [options.secretEnv] : options.secretEnv
    if (names.length === 0) throw new TypeError('secretEnv must name at least one environment variable')
    return names.map((name) => serverSecretEnvName(name, 'secretEnv'))
}

/**
 * The secrets a request may be signed with. Simulated mode: the per-checkout dev secret's bytes as the key, so a test
 * signs with `whsec_` and the base64 of `devWebhookSecret()`. Real mode: every whitespace-separated value of every
 * named variable.
 */
function configuredSecrets(envNames: readonly string[]): string[] {
    if (isSimulated) return [SECRET_PREFIX + Buffer.from(devWebhookSecret()).toString('base64')]
    return envNames.flatMap((name) => (process.env[name] ?? '').split(/\s+/).filter(Boolean))
}

/** key -> the moment its signature stops being fresh (max(now, timestamp) + tolerance), as Mailgun's token guard. */
const seen = new Map<string, number>()

/**
 * The in-process claim, at the instant `nowMs`. The verifier passes the same instant its freshness check used, so a
 * message is never both fresh and forgotten: a claim is pruned only strictly after its expiry, and at its expiry the
 * signature still verifies.
 */
function claimInProcess(key: string, expiresAtMs: number, nowMs: number): boolean {
    // Prune first, so the map cannot grow without bound across a long-lived process.
    for (const [held, expiry] of seen) {
        if (expiry < nowMs) seen.delete(held)
    }
    if (seen.has(key)) return false
    seen.set(key, expiresAtMs)
    return true
}

/** Test-only: forget every claim the in-process store holds. */
export function __resetStandardWebhookReplayGuard(): void {
    seen.clear()
}

/**
 * The replay store's key for a message: the sender (the variables its secret is read from), its id and its timestamp,
 * unambiguously joined. The sender is part of it so that one sender's ids never collide with another's, and so a
 * sender holding one route's secret cannot claim keys another sender will use.
 */
function claimKey(envNames: readonly string[], id: string, timestamp: number): string {
    return JSON.stringify([[...envNames].sort(), id, timestamp])
}

/** How long past the end of its window a claim is kept, for a store's latency and clock skew (see the store's doc). */
const CLAIM_MARGIN_MS = 60_000

interface Verified {
    webhook: VerifiedStandardWebhook
    release: () => Promise<void>
}

async function verifyAndClaim(
    request: Request,
    envNames: readonly string[],
    options: StandardWebhookOptions,
): Promise<Verified> {
    const toleranceMs = toleranceOf(options)
    const secrets = configuredSecrets(envNames)
    if (secrets.length === 0) throw new AuthRequiredError()

    const standard = Object.values(STANDARD_WEBHOOK_HEADERS).some((name) => request.headers.has(name))
    const names = standard ? STANDARD_WEBHOOK_HEADERS : SVIX_WEBHOOK_HEADERS
    const id = request.headers.get(names.id)
    const timestamp = request.headers.get(names.timestamp)
    const signature = request.headers.get(names.signature)
    // Refuse what the headers alone condemn (absent, malformed, stale) before reading a body nobody signed.
    const headersOnly = { id, timestamp, signature, body: '', secrets: [], toleranceMs, now: new Date() }
    const early = verifyStandardWebhookSignature(headersOnly)
    if (!early.ok && early.reason !== 'signature') throw new AuthRequiredError()

    // A clone, so the handler can still read the request's own body.
    const bytes = new Uint8Array(await request.clone().arrayBuffer())

    // The clock is read AFTER the body has arrived, and nothing awaits between this freshness check and the in-process
    // claim, which uses the same instant: a body sent slowly cannot carry a replay past the claim's expiry.
    const now = new Date()
    const result = verifyStandardWebhookSignature({ id, timestamp, signature, body: bytes, secrets, toleranceMs, now })
    if (!result.ok || !id || !timestamp) throw new AuthRequiredError()

    const seconds = Number(timestamp)
    const key = claimKey(envNames, id, seconds)
    // Remembered until the signature stops verifying: the timestamp may run up to the tolerance AHEAD of the clock.
    const expiresAtMs = Math.max(now.getTime(), seconds * 1000) + toleranceMs + CLAIM_MARGIN_MS
    const store = options.replayStore
    const claimed = store ? await store.claim(key, expiresAtMs) : claimInProcess(key, expiresAtMs, now.getTime())
    if (!claimed) throw new AuthRequiredError()

    return {
        // ignoreBOM keeps a leading byte-order mark in the text, as it was signed; the request carries the exact bytes.
        webhook: { id, timestamp: seconds, body: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) },
        release: async () => {
            if (store) await store.release(key)
            else seen.delete(key)
        },
    }
}

/**
 * Verify a Standard Webhooks request (signature, freshness, single use) and return what it carried, or throw the
 * opaque AuthRequiredError. The request's body is read from a clone, so it stays readable. The message stays claimed:
 * a caller that does not then process it successfully should use `withStandardWebhookSignature`, which releases it.
 * A `secretEnv` that names no server-only variable throws a TypeError.
 */
export async function verifyStandardWebhook(
    request: Request,
    options: StandardWebhookOptions,
): Promise<VerifiedStandardWebhook> {
    const { webhook } = await verifyAndClaim(request, secretEnvNames(options), options)
    return webhook
}

/**
 * Route guard for a Standard Webhooks sender: runs `handler` only for a request that verifies
 * (`verifyStandardWebhook`), handing it the verified id, timestamp and raw body, and answers anything else with the
 * same opaque 401 `{ error: 'unauthorized' }` BEFORE the handler is called. When the handler throws or answers 5xx the
 * message is released from the replay store, so the sender's resend of it is processed; the error propagates.
 *
 * Under `webhooks/` the authorization scan exempts a route whose handler IS this call, `export const POST =
 * withStandardWebhookSignature(…, { secretEnv: 'PARTNER_WEBHOOK_SECRET' })`, as it does `withWebhookSecret(…)`. The
 * options are checked when the route module loads, so a bad `secretEnv` fails there, not on a request.
 */
export function withStandardWebhookSignature(
    handler: (ctx: { request: Request; webhook: VerifiedStandardWebhook }) => Promise<Response>,
    options: StandardWebhookOptions,
): (request: Request) => Promise<Response> {
    const envNames = secretEnvNames(options)
    return async (request) => {
        let verified: Verified
        try {
            verified = await verifyAndClaim(request, envNames, options)
        } catch (error) {
            if (error instanceof AuthRequiredError) return Response.json({ error: 'unauthorized' }, { status: 401 })
            throw error
        }
        try {
            const response = await handler({ request, webhook: verified.webhook })
            // Released quietly: a store that cannot release must not replace the handler's own answer.
            if (response.status >= 500) await verified.release().catch(() => {})
            return response
        } catch (error) {
            // The handler's error is the one to see: a store that also fails to release must not replace it.
            await verified.release().catch(() => {})
            throw error
        }
    }
}
