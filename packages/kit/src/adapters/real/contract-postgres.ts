import { type Kysely, sql } from 'kysely'
import type { Login } from '../../db/owner-pass'
import type { DB } from '../../db/schema'
import { makeTestTmpDir } from '../../testing/tmp-dir'

/**
 * TEST ONLY: a real Postgres for a contract suite, and the databases of its own on it. The contract runner
 * (`@sssb/kit/testing/contract`) and the framework's own contract tests (./db.contract.test.ts,
 * ./rds-data.contract.test.ts) start their server here. It lives in `adapters/` because it drives `pg`, which only
 * an adapters directory may import; nothing in an app's request path or a deployment imports it. Generic: it names
 * no app, no seam and no migration. It is also where the "embedded-postgres or a server you run" decision lives, once.
 *
 * WHY EVERY SUITE NEEDS A DATABASE OF ITS OWN. Two migration sets share the framework's 0001-0999 and differ from
 * 1001 up, so running the second set's `migrateToLatest` over a database the first has migrated makes Kysely report
 * corrupted migrations. One server, one database per suite (`<slug>_contract`, `sssb_contract`), is how every
 * app's per-app migrations meet real Postgres without meeting each other's.
 *
 * Two modes, picked by the environment and the same for every caller:
 *  - CONTRACT_DATABASE_URL set (CI's service container): that server, which several suites share, each in its own
 *    database. The URL must be a SUPERUSER's, to a database that already exists (`postgres`).
 *  - unset (a developer's machine): an embedded-postgres of the suite's own, on `port` (or CONTRACT_PG_PORT), its
 *    data in a scratch directory, stopped when the suite ends. `embedded-postgres` is an OPTIONAL peer of
 *    @sssb/kit, loaded only in this mode (docs/decision-log.md, "The contract runner ships in @sssb/kit/testing").
 */

/**
 * A contract run's connections use no TLS: the embedded server has none, and neither has CI's service container. A
 * CONTRACT_DATABASE_URL that sets `sslmode` is refused by the adapter (./db.ts), as a deployment's would be. TLS itself
 * is proven by ./db-tls.contract.test.ts, against a server of its own that refuses anything else.
 */
export const CONTRACT_SSL = { mode: 'disable' } as const

export interface ContractServer {
    /** The server's SUPERUSER URL, to its maintenance database. */
    readonly url: string
    /** The superuser's login, as the owner pass and the proofs take it. */
    readonly superuser: { user: string; password: string }
    /** A database that already exists on the server (the one `url` names). */
    readonly maintenanceDatabase: string
    /** The URL of `database` on this server, as the superuser, or as `login` when given. */
    urlFor(database: string, login?: { user: string; password: string }): string
    /**
     * A pooled connection for a login to a database, through the REAL adapter (`createRealDb`: its pool, its type
     * parsers, its connection-error listener), so a contract pass proves the driver configuration an app deploys.
     * Closed by its caller, or by `stop`.
     */
    connect(login: Login): Kysely<DB>
    /** The superuser's connection to `database`. */
    connectAsSuperuser(database: string): Kysely<DB>
    /** `CREATE DATABASE`, tolerating one that is already there (a reused live server). */
    createDatabase(database: string): Promise<void>
    /** Drops a database if it is there and creates it again, empty: for a suite that must start from nothing. */
    recreateDatabase(database: string): Promise<void>
    /** Closes every connection still open, then stops the embedded server (a no-op for an external one). */
    stop(): Promise<void>
}

export interface ContractServerOptions {
    /** The embedded server's port; CONTRACT_PG_PORT when omitted. Unused when CONTRACT_DATABASE_URL is set. */
    port?: number | undefined
}

/** The name goes into an identifier. It is built by contractDatabaseName or is a fixed literal, never client input, but
 *  it is still held to the shape an unquoted identifier has. */
function checkedName(database: string): string {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(database)) throw new Error(`invalid contract database name: ${database}`)
    return database
}

/** The embedded server's port: the caller's, else CONTRACT_PG_PORT, else a refusal that says how to give one. */
function embeddedPort(port: number | undefined): number {
    const raw = port ?? process.env['CONTRACT_PG_PORT']
    const value = Number(raw)
    if (raw === undefined || raw === '' || !Number.isInteger(value) || value <= 0 || value > 65_535) {
        throw new Error(
            `the contract suite needs a port for its embedded Postgres (got ${String(raw)}): pass { port } ` +
                "(portFor('contractPg') from @sssb/tools/ports), set CONTRACT_PG_PORT, or set CONTRACT_DATABASE_URL " +
                "to a superuser's URL on a server you run",
        )
    }
    return value
}

/** `embedded-postgres`, loaded only when no server was named: an optional peer, so it may not be installed. */
async function loadEmbeddedPostgres() {
    try {
        return (await import('embedded-postgres')).default
    } catch (error) {
        throw new Error(
            'the contract suite starts its own Postgres with `embedded-postgres`, an optional peer of @sssb/kit that ' +
                "this app does not have: add it to the app's devDependencies (and its platform packages to the " +
                "workspace's allowBuilds), or set CONTRACT_DATABASE_URL to a superuser's URL on a server you run",
            { cause: error },
        )
    }
}

export async function startContractServer(label: string, options: ContractServerOptions = {}): Promise<ContractServer> {
    let embedded: { stop(): Promise<void> } | null = null
    let serverUrl = process.env['CONTRACT_DATABASE_URL'] ?? ''
    if (!serverUrl) {
        const port = embeddedPort(options.port)
        const EmbeddedPostgres = await loadEmbeddedPostgres()
        const server = new EmbeddedPostgres({
            databaseDir: makeTestTmpDir(`${label}-pg-`),
            user: 'postgres',
            password: 'postgres',
            port,
            persistent: false,
        })
        await server.initialise()
        await server.start()
        embedded = server
        serverUrl = `postgres://postgres:postgres@localhost:${port}/postgres`
    }

    // Loaded here, not at the top: ./db reaches the migration registry, which imports the app's seam
    // (`@sssb/app-config/*`), and a module that only needs this file's helpers (contractDatabaseName, say) must load
    // without one.
    const { createRealDb } = await import('./db')
    const parsed = new URL(serverUrl)
    const superuser = { user: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) }
    const maintenanceDatabase = parsed.pathname.slice(1) || 'postgres'
    const open: Kysely<DB>[] = []

    const urlFor = (database: string, login?: { user: string; password: string }): string => {
        const url = new URL(serverUrl)
        if (login) {
            url.username = encodeURIComponent(login.user)
            url.password = encodeURIComponent(login.password)
        }
        url.pathname = `/${database}`
        return url.toString()
    }

    const connect = (login: Login): Kysely<DB> => {
        // The real adapter's own pool, parsers and listeners: it used to be a bare `pg` Pool here, so an app's contract
        // run proved a different driver configuration from the one it deploys (a `date` column came back as a JS Date
        // here and as a string from the deployed adapter). Destroying the Kysely ends the pool, which `stop` does for
        // every one still open.
        const db = createRealDb(urlFor(login.database, login), CONTRACT_SSL).getDb()
        open.push(db)
        return db
    }

    return {
        url: serverUrl,
        superuser,
        maintenanceDatabase,
        urlFor,
        connect,
        connectAsSuperuser: (database) => connect({ ...superuser, database }),
        async createDatabase(database) {
            const admin = connect({ ...superuser, database: maintenanceDatabase })
            try {
                await sql`CREATE DATABASE ${sql.id(checkedName(database))}`.execute(admin)
            } catch (error) {
                // A reused live server already has it; the proofs stamp their own rows, so that is fine.
                if (!/already exists/.test(String(error))) throw error
            } finally {
                await admin.destroy()
            }
        },
        async recreateDatabase(database) {
            const admin = connect({ ...superuser, database: maintenanceDatabase })
            try {
                await sql`DROP DATABASE IF EXISTS ${sql.id(checkedName(database))} WITH (FORCE)`.execute(admin)
                await sql`CREATE DATABASE ${sql.id(database)}`.execute(admin)
            } finally {
                await admin.destroy()
            }
        },
        async stop() {
            await Promise.all(open.map((db) => db.destroy().catch(() => undefined)))
            await embedded?.stop()
        },
    }
}
