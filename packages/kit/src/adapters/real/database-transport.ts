/**
 * How the app reaches Postgres: DATABASE_TRANSPORT, the deployment parameter each app records as
 * `params.database.transport` in its `config/params.ts` (the deployment sets the variable from it). An
 * explicit switch, never inferred from which variables happen to be set — a deployment that
 * half-configures the Data API must fail, not quietly fall back to `pg`.
 *
 * - `pg` (the default): node-postgres over a socket, from a Lambda inside the database's VPC.
 * - `data-api` (opt-in): the RDS Data API over HTTPS, from a Lambda outside any VPC (ADR-0002, addendum
 *   2026-11-16). Its three variables replace DATABASE_URL, and its module is imported only when chosen.
 *
 * Its own module so the migrator Lambda (./migrate-handler.ts) reads the same switch without importing
 * ./index.ts and, with it, every other real adapter's SDK.
 */
import { isAbsolute } from 'node:path'

export const DATABASE_TRANSPORTS = ['pg', 'data-api'] as const
export type DatabaseTransport = (typeof DATABASE_TRANSPORTS)[number]

/**
 * The database variables each transport requires, each mapped to its cutover row. `assertRealEnv`
 * (./index.ts) checks them at boot, and @sssb/cdk's test (packages/cdk/src/sssb-app.test.js) checks that every
 * app's deployment sets them, by importing this from the framework that app resolves — so the runtime and the
 * infra draft cannot drift apart on a name.
 */
export const DATABASE_ENV: Record<DatabaseTransport, Record<string, string>> = {
    pg: { DATABASE_URL: 'cloud-accounts' },
    'data-api': { DATABASE_CLUSTER_ARN: 'data-api', DATABASE_SECRET_ARN: 'data-api', DATABASE_NAME: 'data-api' },
}

export function databaseTransport(): DatabaseTransport {
    const value = process.env['DATABASE_TRANSPORT'] ?? 'pg'
    if (!(DATABASE_TRANSPORTS as readonly string[]).includes(value)) {
        throw new Error(`DATABASE_TRANSPORT must be one of ${DATABASE_TRANSPORTS.join(', ')} (got "${value}")`)
    }
    return value as DatabaseTransport
}

/**
 * DATABASE_RESUME_BUDGET_MS, optional and read on `data-api` only: how long a call waits for a paused cluster to
 * resume (docs/runbooks/data-api.md, step 6). Undefined when unset or empty, so that the dialect's default holds. At
 * most 15 minutes, far past any server's timeout, so that a wrong unit fails at boot.
 */
export function databaseResumeBudgetMs(): number | undefined {
    const value = process.env['DATABASE_RESUME_BUDGET_MS']
    if (!value) return undefined
    const ms = /^\d+$/.test(value) ? Number(value) : NaN
    if (!(ms <= 900_000)) {
        throw new Error(
            `DATABASE_RESUME_BUDGET_MS must be a whole number of milliseconds from 0 to 900000 (got "${value}")`,
        )
    }
    return ms
}

/**
 * How the `pg` transport protects its connection: DATABASE_SSL_MODE, with DATABASE_SSL_ROOT_CERT, both optional and
 * read on `pg` only (the Data API speaks HTTPS through the AWS SDK, which verifies AWS's certificate itself). The server
 * (./index.ts) and the migrator (./migrate-handler.ts) both read them here, so the two connect alike.
 *
 * - `verify-full` (the default, and what an unset or empty variable means): TLS, refusing a server whose certificate
 *   does not chain to a trusted root or does not name the host the URL connects to (libpq's `verify-full`). The roots
 *   are the file DATABASE_SSL_ROOT_CERT names, an absolute path to a PEM bundle, when it is set, and Node's own
 *   otherwise (its bundled roots and any NODE_EXTRA_CA_CERTS adds). Aurora's certificates chain to Amazon RDS's own
 *   roots, which Node does not trust, so `SssbApp` points DATABASE_SSL_ROOT_CERT at the Amazon CA bundle the Lambda
 *   Node.js runtime carries (`/var/runtime/ca-cert.pem`).
 * - `disable`: no TLS. For a Postgres that has none: a local server, a contract run's. Never a deployed database.
 *
 * No mode in between: `require` (TLS without checking whose certificate it is) stops a passive listener and not an
 * active one, and a server whose root you cannot name is better served by naming it. docs/decision-log.md, "An SSL
 * mode for the pg transport", says why, and why the mode is not a `config/params.ts` key.
 */
export const DATABASE_SSL_MODES = ['verify-full', 'disable'] as const
export type DatabaseSslMode = (typeof DATABASE_SSL_MODES)[number]
export type DatabaseSsl =
    { readonly mode: 'verify-full'; readonly rootCert?: string | undefined } | { readonly mode: 'disable' }

export function databaseSsl(): DatabaseSsl {
    const mode = process.env['DATABASE_SSL_MODE'] || 'verify-full'
    const rootCert = process.env['DATABASE_SSL_ROOT_CERT'] || undefined
    if (!(DATABASE_SSL_MODES as readonly string[]).includes(mode)) {
        throw new Error(`DATABASE_SSL_MODE must be one of ${DATABASE_SSL_MODES.join(', ')} (got "${mode}")`)
    }
    if (mode === 'disable') {
        // A setting its choice does not use is refused rather than ignored: whoever set it meant TLS.
        if (rootCert !== undefined) {
            throw new Error(
                'DATABASE_SSL_ROOT_CERT is set, but DATABASE_SSL_MODE is disable, which uses no certificate',
            )
        }
        return { mode }
    }
    if (rootCert !== undefined && !isAbsolute(rootCert)) {
        throw new Error(`DATABASE_SSL_ROOT_CERT must be an absolute path to a PEM file (got "${rootCert}")`)
    }
    return { mode: 'verify-full', rootCert }
}
