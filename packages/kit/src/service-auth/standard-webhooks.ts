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
export const STANDARD_WEBHOOK_HEADERS = {
    id: 'webhook-id',
    timestamp: 'webhook-timestamp',
    signature: 'webhook-signature',
} as const

/** The same headers as a Svix sender names them, read when no `webhook-*` header is present. */
export const SVIX_WEBHOOK_HEADERS = { id: 'svix-id', timestamp: 'svix-timestamp', signature: 'svix-signature' } as const

/**
 * Where verified messages are remembered until their window closes, so the same signed message is not accepted
 * twice. `claim` records `key` until `expiresAtMs` and answers false when it is already held (and has not expired);
 * `release` forgets it. The default is per-process; a multi-instance deployment passes a shared one.
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

/** The HMAC key a `whsec_…` secret carries, or null when it is not one. */
function secretKey(secret: string): Buffer | null {
    const encoded = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret
    if (!BASE64.test(encoded)) return null
    const key = Buffer.from(encoded, 'base64')
    return key.length > 0 ? key : null
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
    if (!key) throw new TypeError('a Standard Webhooks secret is whsec_ and the base64 of its key')
    return `v1,${hmac(key, id, String(timestampSec), bodyBytes(body)).toString('base64')}`
}

/**
 * The pure check, no replay state: the fields are present and the timestamp is whole seconds (`malformed`), within
 * `toleranceMs` of `now` either way (`stale`), and some `v1` signature in the space-separated `signature` list equals
 * the HMAC under some secret in `secrets`, compared in constant time (`signature`). A secret that is not
 * `whsec_`-and-base64 matches nothing. Signatures of another version (`v1a`, asymmetric) are ignored, never accepted.
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
    const toleranceMs = params.toleranceMs ?? WEBHOOK_REPLAY_TOLERANCE_MS
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

/** The env var names `options.secretEnv` gives, each checked (./secret-env.ts); at least one. */
function secretEnvNames(options: StandardWebhookOptions): readonly string[] {
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

const inProcessReplayStore: StandardWebhookReplayStore = {
    claim(key, expiresAtMs) {
        const nowMs = Date.now()
        // Prune first, so the map cannot grow without bound across a long-lived process.
        for (const [held, expiry] of seen) {
            if (expiry <= nowMs) seen.delete(held)
        }
        if (seen.has(key)) return false
        seen.set(key, expiresAtMs)
        return true
    },
    release(key) {
        seen.delete(key)
    },
}

/** Test-only: forget every claim the in-process store holds. */
export function __resetStandardWebhookReplayGuard(): void {
    seen.clear()
}

/** The replay store's key for a message: its id and timestamp, unambiguously joined. */
function claimKey(id: string, timestamp: number): string {
    return JSON.stringify([id, timestamp])
}

interface Verified {
    webhook: VerifiedStandardWebhook
    release: () => Promise<void>
}

async function verifyAndClaim(
    request: Request,
    envNames: readonly string[],
    options: StandardWebhookOptions,
): Promise<Verified> {
    // The server's clock, never one a caller passes: the in-process store prunes by it too.
    const now = new Date()
    const secrets = configuredSecrets(envNames)
    if (secrets.length === 0) throw new AuthRequiredError()

    const standard = Object.values(STANDARD_WEBHOOK_HEADERS).some((name) => request.headers.has(name))
    const names = standard ? STANDARD_WEBHOOK_HEADERS : SVIX_WEBHOOK_HEADERS
    const id = request.headers.get(names.id)
    const timestamp = request.headers.get(names.timestamp)
    // A clone, so the handler can still read the request's own body.
    const bytes = new Uint8Array(await request.clone().arrayBuffer())

    const toleranceMs = options.toleranceMs ?? WEBHOOK_REPLAY_TOLERANCE_MS
    const result = verifyStandardWebhookSignature({
        id,
        timestamp,
        signature: request.headers.get(names.signature),
        body: bytes,
        secrets,
        toleranceMs,
        now,
    })
    if (!result.ok || !id || !timestamp) throw new AuthRequiredError()

    const seconds = Number(timestamp)
    const key = claimKey(id, seconds)
    const store = options.replayStore ?? inProcessReplayStore
    // Remembered until the signature stops verifying: the timestamp may run up to the tolerance AHEAD of the clock.
    const expiresAtMs = Math.max(now.getTime(), seconds * 1000) + toleranceMs
    if (!(await store.claim(key, expiresAtMs))) throw new AuthRequiredError()

    return {
        webhook: { id, timestamp: seconds, body: new TextDecoder().decode(bytes) },
        release: async () => {
            await store.release(key)
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
            if (response.status >= 500) await verified.release()
            return response
        } catch (error) {
            await verified.release()
            throw error
        }
    }
}
