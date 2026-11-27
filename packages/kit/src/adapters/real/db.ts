import { readFileSync } from 'node:fs'
import type { ConnectionOptions } from 'node:tls'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, types, type CustomTypesConfig } from 'pg'
import type { DB } from '../../db/schema'
import type { DbPort } from '../../ports/db'
import { refuseTlsInUrl, type DatabaseSsl } from './database-transport'
import { dbPortFor } from './db-port'

/**
 * A Postgres `date` is a calendar day — no time, no zone — and it reaches application code as the wire
 * string (`'2026-10-03'`), never a JS `Date`. `pg`'s default parser builds `new Date(y, m, d)`: LOCAL
 * midnight in whatever zone the server process runs in, which east of UTC is still the previous day
 * once read back as UTC. There is no zone-safe `Date` to build from a value that was never an instant,
 * so none is built. The schema types every `date` column as `string`, and this is what makes that true.
 *
 * `date[]` is parsed as a text array, so an array of days is an array of strings (its own default
 * rebuilds each element with the same local-midnight `Date`). The fake adapter configures pglite
 * identically (`openPglite`, ../fake/pglite-dialect.ts), and the fixture's `due_on` proof pins both.
 *
 * Scoped to THIS adapter's pool rather than `types.setTypeParser`, which would rewrite the parser for
 * every `pg` client in the process, from whichever module happened to be imported first.
 */
type Oid = Parameters<typeof types.getTypeParser>[0]
// pg-types' `TypeId` enum names scalar types only, so the two array OIDs are cast into it.
const DATE_ARRAY_OID = 1182 as Oid
const TEXT_ARRAY_OID = 1009 as Oid
const pgTypes: CustomTypesConfig = {
    getTypeParser: (oid, format = 'text') => {
        if (format === 'text' && oid === types.builtins.DATE) return (value: string) => value
        if (format === 'text' && oid === DATE_ARRAY_OID) return types.getTypeParser(TEXT_ARRAY_OID, format)
        return types.getTypeParser(oid, format)
    },
}

/**
 * AUTHORED — CUTOVER (`cloud-accounts`, `db-tls`): typechecked, never run against Aurora. The migrator
 * Lambda and the app share this adapter. The server's connection details come from DATABASE_URL (Secrets
 * Manager-injected in deployed environments); the migrator builds its URL from the secret (./migrate-handler.ts).
 * This is the default transport (`DATABASE_TRANSPORT=pg`), for a Lambda inside the database's VPC; the RDS Data API
 * one is ./db-data-api.ts.
 *
 * `ssl` is the connection's TLS, always given, never left to the URL or to `pg`'s own defaults (which, with no
 * `sslmode` in the URL and no PGSSLMODE, are no TLS at all): the deployment's `databaseSsl()`
 * (./database-transport.ts), or `{ mode: 'disable' }` for a server that has none, as a contract run's.
 */
export function createRealDb(databaseUrl: string, ssl: DatabaseSsl): DbPort {
    refuseTlsInUrl(databaseUrl)
    const pool = new Pool({ connectionString: databaseUrl, ssl: pgSslOptions(ssl), max: 5, types: pgTypes })
    // Every client gets its own listener as it connects, for its whole life, idle or checked out.
    pool.on('connect', (client) => client.on('error', logConnectionError))
    // pg-pool re-emits an IDLE client's error on the pool. The client's listener above has logged it, and
    // any other error the pool emits (a failed connect, a client being removed) has already reached the
    // caller that asked for it, so this listener exists only so the event is not an uncaught exception.
    pool.on('error', () => undefined)
    return dbPortFor(new Kysely<DB>({ dialect: new PostgresDialect({ pool }) }))
}

/**
 * A pooled connection the server ended: a failover, a reboot, an idle-session timeout, a socket dropped
 * while the Lambda sat frozen between invocations. pg reports it as an 'error' EVENT on the client, and an
 * event with no listener is an uncaught exception, which crashes the process: between requests if the
 * connection was idle, in the middle of one if a transaction held it. pg-pool listens to idle clients only,
 * and Kysely adds no listener to the client it checks out, which it does for every transaction, every
 * `withTenant` and the migrator's run. So every client gets this listener. If a query or transaction was
 * using the connection, that query fails with its own error as usual. Either way, the pool drops the dead
 * client and the next query opens a fresh one.
 *
 * Logged with `console.warn`, which reaches CloudWatch in Lambda. SSSB has no logger port, and Sentry is
 * loaded only when a DSN is configured (../sentry/init.ts), so the adapter does not import it. Only the
 * error's code and message are logged (57P01 is "terminating connection due to administrator command").
 * They carry no credentials, unlike the error object itself, whose `client` holds the password. The Data
 * API transport has no such pool: it speaks HTTPS through the SDK, whose failures reject the call that
 * made them.
 */
function logConnectionError(error: Error & { code?: string }): void {
    console.warn(`SSSB db: a pooled database connection ended (${error.code ?? 'no code'}: ${error.message})`)
}

/**
 * What `pg` hands `tls.connect` for a mode. `verify-full` is `rejectUnauthorized`, which checks the chain, and Node's
 * default `checkServerIdentity`, which checks the certificate names the host: `pg` sets `servername` to the URL's host
 * when it is a name, so a name in the URL is matched against the certificate's names, and an IP address only against
 * its IP addresses. With a root file, its certificates are the only roots this connection trusts.
 */
export function pgSslOptions(ssl: DatabaseSsl): false | ConnectionOptions {
    if (ssl.mode === 'disable') return false
    if (ssl.rootCert === undefined) return { rejectUnauthorized: true }
    let ca: string
    try {
        ca = readFileSync(ssl.rootCert, 'utf8')
    } catch (error) {
        throw new Error(`SSSB db: cannot read the database's root certificates at ${ssl.rootCert}`, { cause: error })
    }
    // Node takes an empty `ca` as no `ca`, and trusts its own roots instead: an empty or truncated file would quietly
    // widen what this connection trusts. A file with no certificate in it is refused.
    if (!ca.includes('-----BEGIN CERTIFICATE-----')) {
        throw new Error(`SSSB db: the database's root certificate file at ${ssl.rootCert} holds no PEM certificate`)
    }
    return { rejectUnauthorized: true, ca }
}
