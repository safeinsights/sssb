import { timingSafeEqual } from 'node:crypto'
import { isSimulated } from '../adapters/index'
import { devWebhookSecret } from '../adapters/fake/service-auth'
import { AuthRequiredError } from '../ports/errors'
import { presentedCredential } from './credential'
import { serverSecretEnvName } from './secret-env'

/**
 * The header a webhook caller sends the shared secret in: `x-sssb-webhook-secret: <secret>`. Send this one, not
 * `Authorization`, through a deployment's public host: CloudFront replaces `Authorization` with its own signature on
 * the way to the server (./credential.ts). `Authorization: Bearer <secret>` is still accepted when this is absent.
 */
export const WEBHOOK_SECRET_HEADER = 'x-sssb-webhook-secret'

/** The environment variable real mode reads the shared secret from when a caller names none. */
const DEFAULT_WEBHOOK_SECRET_ENV = 'WEBHOOK_SECRET'

export interface WebhookSecretOptions {
    /**
     * The environment variable that holds the shared secret in real mode, for a route whose sender already has a
     * secret deployed under another name. Defaults to `WEBHOOK_SECRET` (DEFAULT_WEBHOOK_SECRET_ENV), the one the
     * framework's own routes use and every real deployment must set. A name of your own is yours to set in the
     * deployment: SSSB's real-environment checks (`assertRealEnv`, `sssb check-real-env`) know only the default.
     * Simulated mode ignores it and uses the per-checkout dev secret, as it does for the default.
     */
    secretEnv?: string
}

/** The env var a caller's options name, checked (./secret-env.ts). */
function webhookSecretEnv(options?: WebhookSecretOptions): string {
    return serverSecretEnvName(options?.secretEnv ?? DEFAULT_WEBHOOK_SECRET_ENV, 'secretEnv')
}

/**
 * The shared secret an inbound webhook must present. Simulated mode uses the lazily-generated
 * per-checkout dev secret (statically imported behind isSimulated — the /api/auth/dev-signin
 * precedent for pulling a fake-only helper into shared glue); real mode uses the named environment variable,
 * WEBHOOK_SECRET by default (a cutover row). Null when real mode has no secret configured → auth always fails.
 */
function expectedSecret(envName: string): string | null {
    return isSimulated ? devWebhookSecret() : (process.env[envName] ?? null)
}

/**
 * Verifies an inbound webhook's shared secret, read from `x-sssb-webhook-secret` or else `Authorization: Bearer`
 * (./credential.ts), in constant time. A missing credential, an unset expected secret, or any mismatch throws the
 * same opaque AuthRequiredError. timingSafeEqual
 * requires equal-length buffers, so a length mismatch is short-circuited to a non-match rather than
 * allowed to throw — the comparison itself never leaks length via timing. `options.secretEnv` names the variable
 * real mode reads (WebhookSecretOptions); a name that is not a server-only variable's throws a TypeError.
 */
export function verifyWebhookCaller(request: Request, options?: WebhookSecretOptions): void {
    const envName = webhookSecretEnv(options)
    const credential = presentedCredential(request, WEBHOOK_SECRET_HEADER)
    if (!credential) throw new AuthRequiredError()
    const presented = Buffer.from(credential)

    const expected = expectedSecret(envName)
    if (!expected) throw new AuthRequiredError()
    const expectedBuf = Buffer.from(expected)

    if (presented.length !== expectedBuf.length || !timingSafeEqual(presented, expectedBuf)) {
        throw new AuthRequiredError()
    }
}

/**
 * Route guard for an inbound machine webhook: runs `handler` only for a request that presents the shared
 * secret (`verifyWebhookCaller`), and answers anything else with the same opaque 401 `{ error: 'unauthorized' }`
 * BEFORE the handler is called. Any other error is the handler's own and propagates.
 *
 * A route under `webhooks/` is exempt from the per-actor `authorize(...)` scan because a machine caller is not a
 * user session, and the scan accepts that on one condition: the handler must be a call to `withWebhookSecret(` (or
 * another wrapper the exemption names, `withMailgunSignature(` or `withStandardWebhookSignature(`) by name. So an app's route is `export const POST = withWebhookSecret(...)`, never a
 * bare re-export of a handler that checks the secret somewhere out of the scan's sight. An app that wants port
 * errors mapped (a 409 for a lost state-machine race, say) wraps its own mapper inside, or uses its own guard
 * of the same name; this one deliberately maps nothing. `options.secretEnv` names the variable real mode reads the
 * secret from (WebhookSecretOptions), `WEBHOOK_SECRET` when absent.
 */
export function withWebhookSecret(
    handler: (request: Request) => Promise<Response>,
    options?: WebhookSecretOptions,
): (request: Request) => Promise<Response> {
    // Checked here, when the route module loads, so a mistyped name fails at once and on every request, rather than
    // as a 401 that looks like a wrong secret.
    const secretOptions = { secretEnv: webhookSecretEnv(options) }
    return async (request) => {
        try {
            verifyWebhookCaller(request, secretOptions)
        } catch (error) {
            if (error instanceof AuthRequiredError) return Response.json({ error: 'unauthorized' }, { status: 401 })
            throw error
        }
        return handler(request)
    }
}
