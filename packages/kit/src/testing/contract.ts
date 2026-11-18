import { sql } from 'kysely'
import { afterAll, beforeAll, expect } from 'vitest'
import { startContractServer, type ContractServer } from '../adapters/real/contract-postgres'
import { checkOptOut, registerChecks, runsAny } from './conformance/register'
import type { CheckImpl } from './conformance/types'
import { registerTestTmpDirCleanup } from './tmp-dir'

/**
 * `@sssb/kit/testing/contract`: THE CONTRACT RUNNER (ADR-0014 part 3, step P5). The migrations and the
 * tenant-isolation proofs the unit suite runs on pglite, on REAL Postgres, over the app's own tables, in a database of
 * the app's own. Every app calls it from its `tests/contract/rls-contract.test.ts`, run by the contract Vitest config
 * (`pnpm test:contract`), never by the unit run:
 *
 *     contractSuite({ port: portFor('contractPg'), optOut: {} })
 *
 * Generic: it knows nothing of the app but what the seam hands it (the slug, the migrations, the app's half of the RLS
 * proofs), so every app's file is that one call. Its checks are `contract` checks in `./checks.json`, registered,
 * opted out and guarded against skipping exactly as the unit suite's are (./conformance/register.ts), in this order,
 * which is deliberate:
 *  1. `contract-owner-pass`: a NON-SUPERUSER OWNER migrates and runs the proofs, as Aurora's master user does
 *     (../db/owner-pass.ts says why no other pass could see a missing role switch). It runs first so that on a fresh
 *     server the owner's own migration 0001 is what creates `app_user`; then the same again, now that `app_user`
 *     exists: the branch a reused server takes (CI's service container is shared, so every suite after the first takes
 *     it). Each makes a throwaway database and role and removes them.
 *  2. `contract-rls`: the full proof suite as a superuser, in the app's own database (`<slug>_contract`).
 *  3. `contract-data-api`: the same app's migrations and proofs over the RDS Data API transport, through the
 *     emulator (../adapters/real/rds-data-emulator.ts) on the same server, in a database of its own made empty first,
 *     and the owner pass through it too: the transport an Aurora deployment outside a VPC reaches the database by.
 *
 * It does not prove the framework's migration 0015 branch by branch, a second owner on one cluster, or the Data API
 * transport's own behaviour (its one-transaction migrator, the lock race, the emulator's strictness): those are about
 * the framework, and run once, against SSSB's fixture (packages/kit/src/adapters/real/*.contract.test.ts).
 *
 * The server is CONTRACT_DATABASE_URL's (a superuser's URL; CI's service container) or, unset, an embedded-postgres
 * of the file's own on `port` (or CONTRACT_PG_PORT). `embedded-postgres` is an optional peer: an app that runs this
 * locally has it in its devDependencies (../adapters/real/contract-postgres.ts).
 */

export interface ContractOptions {
    /** The embedded server's port: `portFor('contractPg')` from `@sssb/tools/ports`; CONTRACT_PG_PORT when omitted. */
    port?: number
    /** The app's database; `contractDatabaseName` of the seam's `APP_SLUG` when omitted. */
    database?: string
    /** Checks this app leaves out, each with the reason: `{ '<check id>': '<why>' }`. */
    optOut?: Readonly<Record<string, string>>
}

/**
 * The database name a suite uses for an app: `<slug>_contract`, the slug folded to what an unquoted Postgres
 * identifier may hold. `acme-corp` becomes `acme_corp_contract`, so a renamed app gets its own
 * name with no edit anywhere.
 */
export function contractDatabaseName(slug: string): string {
    // 63 is Postgres's identifier limit; "_contract" is 9 of it.
    const underscored = slug.toLowerCase().replace(/[^a-z0-9]+/g, '_')
    // The leading and trailing underscore trimmed by a loop rather than `/^_+|_+$/`, a pattern that backtracks
    // quadratically on a long run (CodeQL flags it on a caller's input); the collapse above already leaves at most one
    // underscore at each end, so this changes no result.
    let from = 0
    let to = underscored.length
    while (from < to && underscored[from] === '_') from++
    while (to > from && underscored[to - 1] === '_') to--
    const folded = underscored.slice(from, to).slice(0, 50)
    const base = /^[a-z]/.test(folded) ? folded : `app_${folded}`
    return `${base}_contract`
}

/** The Data API pass's own database, beside the app's: the same name with `_data_api`, within the 63 of an identifier. */
const dataApiDatabaseName = (database: string) => `${database.slice(0, 63 - '_data_api'.length)}_data_api`

/** What each contract check is handed: the server and the app's database, both set when the file's tests start. */
interface ContractContext {
    server(): ContractServer
    database(): string
}

// Everything that composes the framework's migrations with the app's reaches the seam, so it is imported when a test
// runs, not when the file is collected: `contractDatabaseName` stays importable with no seam at all.
const migrate = () => import('../db/migrate')
const proofs = () => import('../db/rls-proof-runner')
const dataApi = () => import('../adapters/real/contract-data-api')

const TIMEOUT_MS = 120_000

async function ownerPass(context: ContractContext): Promise<void> {
    const { runOwnerPass } = await import('../db/owner-pass')
    const server = context.server()
    const admin = server.connectAsSuperuser(server.maintenanceDatabase)
    try {
        await runOwnerPass(
            {
                admin,
                superuser: server.superuser,
                maintenanceDatabase: server.maintenanceDatabase,
                connect: (login) => server.connect(login),
            },
            expect,
        )
    } finally {
        await admin.destroy()
    }
}

const IMPLEMENTATIONS: Readonly<Record<string, CheckImpl<ContractContext>>> = {
    'contract-owner-pass': {
        timeouts: {
            'a non-superuser owner migrates, and switches to app_user inside withTenant': TIMEOUT_MS,
            'a non-superuser owner migrates where app_user already exists, and switches too': TIMEOUT_MS,
        },
        tests: {
            'a non-superuser owner migrates, and switches to app_user inside withTenant': ownerPass,
            'a non-superuser owner migrates where app_user already exists, and switches too': async (context) => {
                const server = context.server()
                const admin = server.connectAsSuperuser(server.maintenanceDatabase)
                try {
                    const existing = await sql<{
                        n: number
                    }>`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'app_user'`.execute(admin)
                    expect(existing.rows[0]!.n).toBe(1)
                } finally {
                    await admin.destroy()
                }
                await ownerPass(context)
            },
        },
    },
    'contract-rls': {
        timeouts: { 'the full RLS proof suite passes': TIMEOUT_MS },
        tests: {
            'the full RLS proof suite passes': async (context) => {
                const db = context.server().connectAsSuperuser(context.database())
                await (await migrate()).migrateToLatest(db)
                await (await proofs()).runRlsProofs(db, expect)
            },
        },
    },
    'contract-data-api': {
        timeouts: {
            'the full RLS proof suite passes through the Data API': TIMEOUT_MS,
            'a non-superuser owner migrates, and switches to app_user inside withTenant, through the Data API':
                TIMEOUT_MS,
        },
        tests: {
            'the full RLS proof suite passes through the Data API': async (context) =>
                (await dataApi()).proveRlsThroughDataApi(context.server(), dataApiDatabaseName(context.database())),
            'a non-superuser owner migrates, and switches to app_user inside withTenant, through the Data API': async (
                context,
            ) => (await dataApi()).runDataApiOwnerPass(context.server()),
        },
    },
}

/** Registers the contract suite in the calling test file. Call it once, at the file's top level. */
export function contractSuite(options: ContractOptions = {}): void {
    // First, before the server's own afterAll: the server's data directory is a scratch directory, removed only after
    // the server has stopped, and this file's own, even under `isolate: false` (./tmp-dir.ts).
    registerTestTmpDirCleanup()
    const optOut = options.optOut ?? {}
    checkOptOut('contractSuite', 'contract', optOut)
    if (options.database !== undefined && !/^[a-z][a-z0-9_]{0,62}$/.test(options.database)) {
        throw new Error(`contractSuite: database "${options.database}" is not an unquoted Postgres identifier`)
    }

    let server: ContractServer | undefined
    let database: string | undefined
    const context: ContractContext = {
        server: () => server ?? unstarted(),
        database: () => database ?? unstarted(),
    }

    // Every check opted out: no server to start.
    if (runsAny('contract', optOut)) {
        beforeAll(async () => {
            database = options.database ?? contractDatabaseName((await import('@sssb/app-config/identity')).APP_SLUG)
            server = await startContractServer(database, { port: options.port })
            await server.createDatabase(database)
        }, TIMEOUT_MS)

        afterAll(async () => {
            await server?.stop()
        })
    }

    registerChecks({ caller: 'contractSuite', runner: 'contract', implementations: IMPLEMENTATIONS, optOut, context })
}

function unstarted(): never {
    throw new Error('contractSuite: the contract server did not start (see the beforeAll failure above)')
}
