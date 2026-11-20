import { isSimulated } from '../adapters/index'
import { devWebhookSecret } from '../adapters/fake/service-auth'
import { verifyMailgunSignature, WEBHOOK_REPLAY_TOLERANCE_MS } from '../core/webhook-signing'
import { AuthRequiredError } from '../ports/errors'

/**
 * Mailgun inbound-webhook verification — the RECEIVING half of the Mailgun vendor, beside the
 * shared-secret job verifier (webhook.ts). It is the counterpart of that file: the pure signature math
 * lives in packages/kit/src/core/webhook-hmac.ts (verifyMailgunSignature, cross-checked against node:crypto),
 * while the two STATEFUL pieces live here — the signing-key lookup and the token replay guard.
 *
 * SIGNING KEY. Simulated mode reuses the per-checkout dev webhook secret (devWebhookSecret — the same
 * lazily-generated secret the job webhook uses; a shared "the dev secret" is fine for a hermetic world,
 * and it lets an integration test SIGN a request Mailgun-style and have it verify). Real mode uses
 * MAILGUN_WEBHOOK_SIGNING_KEY from the environment (the `email-inbound` cutover row). Null when real
 * mode has no key configured → verification always fails.
 *
 * NOTE ON FAKE MODE. The Simulator "compose inbound" flow does NOT go through this verifier — it calls
 * the shared intake function directly through a simulated-mode route (the honest mechanism; spoofing a
 * signature from the panel would be theater). This verifier still runs in simulated mode for the real
 * webhook route so its unit/integration test can exercise the true signed path.
 *
 * REPLAY GUARD. Mailgun sends a unique `token` per request; a replay of the same token inside the
 * freshness window is rejected. The store is an in-process Map of token→expiry, pruned lazily. Its
 * limit, recorded on purpose: it is per-process, so a multi-instance real deployment (several Lambdas)
 * would need a SHARED store (a small DynamoDB/Redis/Postgres table keyed by token) to make the guard
 * global — a cutover note. The timestamp freshness window is the primary, stateless guard; this token
 * set is the in-window dedupe on top. Like the shared-secret verifier, this ships in REAL builds; never add
 * `runtime = 'edge'` upstream.
 */

export interface MailgunSignatureFields {
    timestamp: string
    token: string
    signature: string
}

function signingKey(): string | null {
    return isSimulated ? devWebhookSecret() : (process.env['MAILGUN_WEBHOOK_SIGNING_KEY'] ?? null)
}

/**
 * token -> expiry epoch ms; a token is a replay if seen while still within the window. The expiry is
 * the moment its SIGNATURE stops being fresh, not "tolerance from now": the timestamp may run up to the
 * tolerance AHEAD of our clock (verifyMailgunSignature checks both directions), so a token remembered
 * for only `now + tolerance` would be forgotten while a replay of it still verified.
 */
const seenTokens = new Map<string, number>()

function rememberToken(token: string, nowMs: number, timestampMs: number): boolean {
    // Prune expired entries first so the map can't grow unbounded across a long-lived process.
    for (const [seen, expiry] of seenTokens) {
        if (expiry <= nowMs) seenTokens.delete(seen)
    }
    if (seenTokens.has(token)) return false
    seenTokens.set(token, Math.max(nowMs, timestampMs) + WEBHOOK_REPLAY_TOLERANCE_MS)
    return true
}

/**
 * Verify a Mailgun inbound request's signature + freshness + single-use token, or throw the opaque
 * AuthRequiredError (→ 401 at the route). `now` is injectable for deterministic tests.
 */
export function verifyMailgunWebhook(fields: MailgunSignatureFields, now: Date = new Date()): void {
    const key = signingKey()
    if (!key) throw new AuthRequiredError()
    const result = verifyMailgunSignature({ ...fields, signingKey: key, toleranceMs: WEBHOOK_REPLAY_TOLERANCE_MS, now })
    if (!result.ok) throw new AuthRequiredError()
    if (!rememberToken(fields.token, now.getTime(), Number(fields.timestamp) * 1000)) throw new AuthRequiredError()
}

/**
 * Forget a token whose request was verified but NOT processed: the route's handler threw or answered 5xx.
 * The sender's retry of that message carries the same token, and refusing it as a replay would lose the
 * message. A replay of an unprocessed message is a retry, not a second delivery, so forgetting it opens
 * nothing the timestamp window does not already bound.
 */
export function forgetMailgunToken(token: string): void {
    seenTokens.delete(token)
}

/** Test-only: clear the replay set between cases so a reused fixture token doesn't leak across tests. */
export function __resetMailgunReplayGuard(): void {
    seenTokens.clear()
}
