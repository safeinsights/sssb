import type { Kysely } from 'kysely'
import { expect } from 'vitest'
import { runOwnerPass, type Login } from '../../db/owner-pass'
import { runRlsProofs } from '../../db/rls-proof-runner'
import type { DB } from '../../db/schema'
import type { DbPort } from '../../ports/db'
import { CONTRACT_SSL, type ContractServer } from './contract-postgres'
import { createRealDb } from './db'
import { createRealDataApiDb } from './db-data-api'
import { RdsDataEmulator, type EmulatedCall } from './rds-data-emulator'

/**
 * TEST ONLY: the contract passes over the RDS Data API transport (ADR-0002, addendum 2026-11-16), through
 * ./rds-data-emulator.ts on a real Postgres. Shared by the contract runner (`@sssb/kit/testing/contract`, which runs
 * them over each app's own tables) and the framework's own Data API contract test (./rds-data.contract.test.ts, which
 * adds the transport's framework-specific cases). Nothing in an app's request path or a deployment imports it.
 */

/** ARNs the emulator accepts and ignores: on Aurora they name the cluster and the secret, here nothing. */
export const EMULATED_ARNS = {
    resourceArn: 'arn:aws:rds:us-east-1:000000000000:cluster:emulated',
    secretArn: 'arn:aws:secretsmanager:us-east-1:000000000000:secret:emulated',
} as const

/**
 * The full RLS proof suite through the Data API, in `database`, made EMPTY first so the migrations run through the
 * dialect (in its one transaction) rather than finding a database an earlier run already migrated.
 */
export async function proveRlsThroughDataApi(server: ContractServer, database: string): Promise<void> {
    await server.recreateDatabase(database)
    const emulator = new RdsDataEmulator(server.urlFor(database))
    const port = createRealDataApiDb({ ...EMULATED_ARNS, database, client: emulator })
    try {
        await port.migrateToLatest()
        await runRlsProofs(port.getDb(), expect)
    } finally {
        await port.getDb().destroy()
        await emulator.close()
    }
}

/**
 * The owner pass (../../db/owner-pass.ts), with every connection it opens made through the dialect, to an emulator
 * logged in as that login: on Aurora the secret IS the login. Only `admin` is plain `pg`: it creates the owner, grants
 * it the creator's membership where `app_user` (and any role the app names in `appRoles`) already exists, and tears
 * everything down. None of that is what is
 * being proven. Then: the owner's migrations went the Data API's way (ONE transaction, opening with the
 * transaction-scoped lock, every statement on that one id, ending in a commit, all through the owner's emulator), and
 * its role switch inside withTenant did too (the one-statement setup, inside a transaction).
 */
export async function runDataApiOwnerPass(server: ContractServer): Promise<void> {
    const admin = createRealDb(server.urlFor(server.maintenanceDatabase), CONTRACT_SSL).getDb()
    const opened = new Map<Kysely<DB>, { port: DbPort; emulator: RdsDataEmulator; login: Login }>()
    const closing: Promise<void>[] = []
    const connect = (login: Login): Kysely<DB> => {
        const asLogin = new RdsDataEmulator(server.urlFor(login.database, login))
        const port = createRealDataApiDb({
            ...EMULATED_ARNS,
            database: login.database,
            client: { send: (command) => asLogin.send(command), destroy: () => void closing.push(asLogin.close()) },
        })
        opened.set(port.getDb(), { port, emulator: asLogin, login })
        return port.getDb()
    }
    // The calls the owner's emulator received WHILE the migrations ran: the migration itself, alone.
    let migration: EmulatedCall[] = []
    let migratedAs: Login | undefined
    try {
        await runOwnerPass(
            {
                admin,
                superuser: server.superuser,
                maintenanceDatabase: server.maintenanceDatabase,
                connect,
                migrate: async (ownerDb) => {
                    const { port, emulator: asOwner, login } = opened.get(ownerDb)!
                    const from = asOwner.calls.length
                    await port.migrateToLatest()
                    migration = asOwner.calls.slice(from)
                    migratedAs = login
                },
            },
            expect,
        )
    } finally {
        await Promise.all(closing)
        await admin.destroy()
    }
    expect(migratedAs?.user).toMatch(/^sssb_owner_\d+$/)
    expect(migration.filter((call) => call.operation === 'BeginTransaction')).toHaveLength(1)
    expect(migration[0]?.operation).toBe('BeginTransaction')
    expect(migration[1]?.sql).toMatch(/pg_advisory_xact_lock/)
    expect(new Set(migration.slice(1).map((call) => call.transactionId)).size).toBe(1)
    expect(migration.at(-1)?.operation).toBe('CommitTransaction')
    const owner = [...opened.values()].find(({ login }) => login === migratedAs)!.emulator.calls
    expect(
        owner.some(
            (call) =>
                call.operation === 'ExecuteStatement' &&
                call.transactionId !== undefined &&
                /set_config\('role', 'app_user', true\)/.test(call.sql ?? ''),
        ),
    ).toBe(true)
}
