import { Kysely, sql } from 'kysely'
import { type Migration, Migrator } from 'kysely/migration'
import { expect } from 'vitest'
import { openPglite, PGliteDialect } from '../../adapters/fake/pglite-dialect'
import type { DB } from '../../db/schema'
import type { CheckImpl } from './types'

// Everything that composes the framework's migrations with the app's reaches the seam, so it is imported when a
// test runs, not when the suite is collected.
const migrate = () => import('../../db/migrate')
const registry = () => import('../../db/migrations/index')

const pglite = () => new Kysely<DB>({ dialect: new PGliteDialect(openPglite()) })

/** The four-digit prefix of a migration's name: framework migrations are 0001–0999, the app's ≥1001. */
const migrationPrefix = (name: string): number => Number(/^(\d{4})_/.exec(name)?.[1] ?? Number.NaN)

/**
 * The parts of a schema a migration can change and that must not depend on the order it ran in: above
 * all, the tenancy machinery (RLS enabled and FORCED per table, its policies and their roles, app_user's
 * grants down to the column), then shape (columns, constraints, indexes) and code (triggers, functions).
 */
export async function schemaOf(db: Kysely<DB>) {
    const rows = async (query: ReturnType<typeof sql>) => (await query.execute(db)).rows
    return {
        rls: await rows(sql`
            SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`),
        policies: await rows(sql`
            SELECT tablename, policyname, permissive, roles, cmd, qual, with_check FROM pg_policies
            WHERE schemaname = 'public' ORDER BY tablename, policyname`),
        tableGrants: await rows(sql`
            SELECT table_name, privilege_type FROM information_schema.role_table_grants
            WHERE grantee = 'app_user' ORDER BY table_name, privilege_type`),
        columnGrants: await rows(sql`
            SELECT table_name, column_name, privilege_type FROM information_schema.column_privileges
            WHERE grantee = 'app_user' ORDER BY table_name, column_name, privilege_type`),
        columns: await rows(sql`
            SELECT table_name, column_name, data_type, is_nullable, column_default
            FROM information_schema.columns WHERE table_schema = 'public'
            ORDER BY table_name, column_name`),
        constraints: await rows(sql`
            SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS definition
            FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`),
        indexes: await rows(sql`
            SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`),
        triggers: await rows(sql`
            SELECT event_object_table, trigger_name, event_manipulation, action_timing, action_statement
            FROM information_schema.triggers WHERE trigger_schema = 'public' ORDER BY 1, 2, 3`),
        functions: await rows(sql`
            SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' ORDER BY 1, 2`),
    }
}

/**
 * The database as it stood BEFORE the SSSB update that brings `withheld` (the newest framework migration):
 * the registry minus `withheld`, applied one migration at a time, stopping at the first APP migration
 * that cannot run without it. That migration, and everything after it, arrive with the update and are
 * pending alongside `withheld`, which is how an app migration that builds on a new framework migration
 * reaches a real database. A FRAMEWORK migration failing here is a real defect, and the check fails.
 */
export async function buildPreUpdate(
    db: Kysely<DB>,
    migrations: Record<string, Migration>,
    withheld: string,
): Promise<string[]> {
    const before = Object.fromEntries(Object.entries(migrations).filter(([name]) => name !== withheld))
    const migrator = new Migrator({ db, provider: { getMigrations: async () => before } })
    const ran: string[] = []
    for (;;) {
        const { error, results = [] } = await migrator.migrateUp()
        if (error) {
            // Only an APP migration's own failure ends the build. A framework migration failing, or an
            // error no migration owns (Kysely's own), is a real defect.
            const failed = results.find((result) => result.status === 'Error')?.migrationName
            if (failed === undefined || migrationPrefix(failed) < 1000) throw error
            return ran
        }
        if (results.length === 0) return ran
        ran.push(...results.map((result) => result.migrationName))
    }
}

/** `rls-pglite`: the app's own tables through SSSB's composed proof runner, on the in-process database. */
export const rlsPglite: CheckImpl = {
    timeouts: { 'the full RLS proof suite passes': 30_000 },
    tests: {
        'the full RLS proof suite passes': async () => {
            const { migrateToLatest } = await migrate()
            const { runRlsProofs } = await import('../../db/rls-proof-runner')
            const db = pglite()
            try {
                await migrateToLatest(db)
                await runRlsProofs(db, expect)
            } finally {
                await db.destroy()
            }
        },
    },
}

/**
 * `migration-order`: the upgrade path every adopter takes, and the numbering that makes it safe. Framework
 * migrations (0001–0999) and the app's (≥1001) are two sequences interleaved by name, so a NEW framework migration
 * arriving in an SSSB update sorts BEFORE app migrations the database already ran. The hazard is in how the two
 * compose, so it is checked against each app's own migrations. (The guard's own behaviour, on framework migrations
 * alone, is the kit's test: packages/kit/src/db/migrate.test.ts.)
 */
export const migrationOrder: CheckImpl = {
    timeouts: {
        'applies a framework migration that arrives after app migrations already ran, to the same schema as a fresh database': 60_000,
    },
    tests: {
        'every app migration is numbered ≥1001 and none shares a name with a framework one': async () => {
            const { appMigrations } = await import('@sssb/app-config/db/migrations')
            const { frameworkMigrations } = await registry()
            // An app may register no migrations at all (ADR-0004's addendum allows an app with no tables).
            const app = Object.keys(appMigrations)
            expect(app.filter((name) => !(migrationPrefix(name) >= 1001))).toEqual([])
            expect(Object.keys(frameworkMigrations).filter((name) => !(migrationPrefix(name) < 1000))).toEqual([])
            // A collision would let the app's key silently replace the framework's in the merged map.
            expect(app.filter((name) => Object.hasOwn(frameworkMigrations, name))).toEqual([])
        },
        'applies a framework migration that arrives after app migrations already ran, to the same schema as a fresh database':
            async () => {
                const { migrateToLatest } = await migrate()
                const { frameworkMigrations, migrations } = await registry()
                const latestFramework = Object.keys(frameworkMigrations).sort().at(-1)!

                // The database as it stood before the update that brings the newest framework migration.
                const upgraded = pglite()
                const fresh = pglite()
                try {
                    await buildPreUpdate(upgraded, migrations, latestFramework)
                    await migrateToLatest(upgraded)
                    const ran = await sql<{ name: string }>`SELECT name FROM kysely_migration`.execute(upgraded)
                    expect(ran.rows.map((row) => row.name).sort()).toEqual(Object.keys(migrations).sort())

                    // ...and it ended up where a database migrated from empty does, whatever order got it there.
                    await migrateToLatest(fresh)
                    expect(await schemaOf(upgraded)).toEqual(await schemaOf(fresh))
                } finally {
                    await upgraded.destroy()
                    await fresh.destroy()
                }
            },
    },
}
