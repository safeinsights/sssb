import { Kysely, sql } from 'kysely'
import { type Migration, Migrator } from 'kysely/migration'
import { expect } from 'vitest'
import { openPglite, PGliteDialect } from '../../adapters/fake/pglite-dialect'
import type { FoundRole } from '../../db/app-roles'
import { family } from '../../db/family'
import type { DB } from '../../db/schema'
import type { CheckImpl } from './types'

// Everything that composes the framework's migrations with the app's reaches the seam, so the database family hands
// it over as loaders (../../db/family.ts), run when a test runs, not when the suite is collected.
const migrate = () => family.migrator()
const registry = () => family.migrations()

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

/** The roles a pglite cluster holds, by name. */
const roleNames = async (db: Kysely<DB>): Promise<Set<string>> =>
    new Set((await sql<{ rolname: string }>`SELECT rolname FROM pg_roles`.execute(db)).rows.map((row) => row.rolname))

/**
 * The cluster-wide roles the APP's migrations create, measured on a fresh pglite: the framework's migrations run first,
 * alone, and whatever roles they add (`app_user`) are the framework's; then the app's run, and whatever roles THEY add
 * are the app's. Nothing is assumed about the framework's roles but what its own migrations do. With them, `app_user`
 * and the roles `named`, as the migrations left them (`refusedOf`, ../../db/app-roles.ts).
 */
async function rolesTheAppCreates(named: readonly string[]): Promise<{ created: string[]; found: FoundRole[] }> {
    const { migrateRegistryToLatest } = await migrate()
    const { frameworkMigrations, migrations } = await registry()
    const { refusedOf } = await import('../../db/app-roles')
    const db = pglite()
    try {
        const server = await roleNames(db)
        await migrateRegistryToLatest(db, frameworkMigrations)
        const framework = await roleNames(db)
        await migrateRegistryToLatest(db, migrations)
        const after = await roleNames(db)
        return {
            created: [...after].filter((role) => !server.has(role) && !framework.has(role)).sort(),
            found: await refusedOf(db, named),
        }
    } finally {
        await db.destroy()
    }
}

/**
 * `app-roles`: the roles the app's migrations create are exactly the ones it names in `appRoles`
 * (../../db/app-roles.ts). A role it creates and does not name breaks the owner pass's second run, where a later owner
 * has no ADMIN on it; a name it does not create is one the owner pass would grant ADMIN on all the same, so a stale or
 * hostile name is refused here before any server sees it. And every named role, and the framework's `app_user`, is
 * still ORDINARY once the migrations ran (`refusedOf`): a migration that makes one LOGIN or CREATEDB, the owner of a
 * database, or a member of a privileged role, is caught here, before the owner pass hands every later owner ADMIN on it. Measured once per file,
 * on one pglite.
 */
export const appRolesCheck: CheckImpl = (() => {
    let measured: Promise<{ created: string[]; found: FoundRole[] }> | undefined
    const named = async () => {
        const { appRolesOf } = await import('../../db/app-roles')
        return appRolesOf(await import('@sssb/app-config/db/migrations'))
    }
    const measure = async () => (measured ??= rolesTheAppCreates(await named()))
    const created = async () => (await measure()).created
    return {
        // A fresh measurement for each file that registers the check, even where one worker runs several.
        setup: () => {
            measured = undefined
        },
        timeouts: {
            "every role the app's migrations create is named in appRoles": 60_000,
            "every role appRoles names is created by the app's migrations": 60_000,
            "every role appRoles names is an ordinary role once the app's migrations ran": 60_000,
            "app_user is an ordinary role once the app's migrations ran": 60_000,
        },
        tests: {
            'appRoles, where the app exports it, lists distinct role names the app may own': async () => {
                await named()
            },
            "every role the app's migrations create is named in appRoles": async () => {
                const { APP_ROLES_HOME } = await import('../../db/app-roles')
                const names = await named()
                const unnamed = (await created()).filter((role) => !names.includes(role))
                expect(
                    unnamed,
                    `the app's migrations create ${unnamed.map((role) => `role "${role}"`).join(', ')}, which ` +
                        `appRoles does not name: ${APP_ROLES_HOME}, listing every role they create, so the contract ` +
                        "suite's owner pass can grant a later owner the ADMIN on it its creator holds",
                ).toEqual([])
            },
            "every role appRoles names is created by the app's migrations": async () => {
                const { APP_ROLES_HOME } = await import('../../db/app-roles')
                const roles = await created()
                const stale = (await named()).filter((role) => !roles.includes(role))
                expect(
                    stale,
                    `appRoles names ${stale.map((role) => `role "${role}"`).join(', ')}, which no migration of the app ` +
                        `creates: the owner pass grants ADMIN on every role named, so name only the roles the app's ` +
                        `migrations create (${APP_ROLES_HOME})`,
                ).toEqual([])
            },
            "every role appRoles names is an ordinary role once the app's migrations ran": async () => {
                const { FRAMEWORK_ROLE, ORDINARY_NAMED, shownRefused } = await import('../../db/app-roles')
                const strayed = shownRefused((await measure()).found.filter((role) => role.rolname !== FRAMEWORK_ROLE))
                expect(
                    strayed,
                    `after the app's migrations, appRoles names ${strayed}: the contract suite's owner pass grants every ` +
                        `later owner ADMIN on these roles, so each must stay ordinary: ${ORDINARY_NAMED}`,
                ).toBe('')
            },
            "app_user is an ordinary role once the app's migrations ran": async () => {
                const { FRAMEWORK_ROLE, ORDINARY_APP_USER, shownRefused } = await import('../../db/app-roles')
                const strayed = shownRefused((await measure()).found.filter((role) => role.rolname === FRAMEWORK_ROLE))
                expect(
                    strayed,
                    `after the app's migrations, ${strayed}: the contract suite's owner pass grants every later owner ` +
                        "ADMIN on the framework's app_user, so the app's migrations must leave it ordinary: " +
                        ORDINARY_APP_USER,
                ).toBe('')
            },
        },
    }
})()

/** `rls-pglite`: the app's own tables through SSSB's composed proof runner, on the in-process database. */
export const rlsPglite: CheckImpl = {
    timeouts: { 'the full RLS proof suite passes': 30_000 },
    tests: {
        'the full RLS proof suite passes': async () => {
            const { migrateToLatest } = await migrate()
            const { runRlsProofs } = await family.proofs()
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
