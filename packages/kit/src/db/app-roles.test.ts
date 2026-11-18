import { Kysely, sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { openPglite, PGliteDialect } from '../adapters/fake/pglite-dialect'
import { appRolesOf, checkAppRoles, refusedOf, shownRefused } from './app-roles'
import type { DB } from './schema'

describe('an app role is ordinary, read from a server (pglite)', () => {
    it('refuses each attribute and catalog entry, and every membership but app_user and the named roles, at any depth', async () => {
        const db = new Kysely<DB>({ dialect: new PGliteDialect(openPglite()) })
        try {
            for (const statement of [
                'CREATE ROLE app_user NOLOGIN',
                'CREATE ROLE harbor_clerk NOLOGIN',
                // Ordinary, though a member of app_user and of another named role.
                'CREATE ROLE depot_ok NOLOGIN',
                'GRANT app_user TO depot_ok',
                'GRANT harbor_clerk TO depot_ok',
                'CREATE ROLE depot_login LOGIN',
                'CREATE ROLE depot_createdb NOLOGIN CREATEDB',
                'CREATE ROLE depot_createrole NOLOGIN CREATEROLE',
                'CREATE ROLE depot_bypass NOLOGIN BYPASSRLS',
                'CREATE ROLE depot_replication NOLOGIN REPLICATION',
                'CREATE ROLE depot_super NOLOGIN SUPERUSER',
                // Attribute-free, member of nothing, and more than ordinary through the cluster-wide catalogs.
                'CREATE ROLE depot_parameter NOLOGIN',
                'GRANT ALTER SYSTEM ON PARAMETER archive_command TO depot_parameter',
                'CREATE ROLE depot_database NOLOGIN',
                'CREATE DATABASE depot_db OWNER depot_database',
                'CREATE ROLE depot_tablespace NOLOGIN',
                'SET allow_in_place_tablespaces = on',
                "CREATE TABLESPACE depot_space OWNER depot_tablespace LOCATION ''",
                'CREATE ROLE wharf_boss NOLOGIN SUPERUSER',
                'CREATE ROLE depot_under_boss NOLOGIN',
                'GRANT wharf_boss TO depot_under_boss',
                'CREATE ROLE depot_program NOLOGIN',
                'GRANT pg_execute_server_program TO depot_program',
                // Two levels down, through a role nobody named.
                'CREATE ROLE wharf_middle NOLOGIN',
                'GRANT pg_read_server_files TO wharf_middle',
                'CREATE ROLE depot_chain NOLOGIN',
                'GRANT wharf_middle TO depot_chain',
                // Two levels down through a NAMED role: the named one is allowed, what it leads to is not.
                'CREATE ROLE depot_via_named NOLOGIN',
                'GRANT depot_program TO depot_via_named',
            ]) {
                await sql.raw(statement).execute(db)
            }
            const named = [
                'harbor_clerk',
                'depot_ok',
                'depot_login',
                'depot_createdb',
                'depot_createrole',
                'depot_bypass',
                'depot_replication',
                'depot_super',
                'depot_parameter',
                'depot_database',
                'depot_tablespace',
                'depot_under_boss',
                'depot_program',
                'depot_chain',
                'depot_via_named',
                'depot_absent',
            ]
            const found = await refusedOf(db, named)
            expect(Object.fromEntries(found.map((role) => [role.rolname, role.refused]))).toEqual({
                app_user: [],
                harbor_clerk: [],
                depot_ok: [],
                depot_login: ['LOGIN'],
                depot_createdb: ['CREATEDB'],
                depot_createrole: ['CREATEROLE'],
                depot_bypass: ['BYPASSRLS'],
                depot_replication: ['REPLICATION'],
                depot_super: ['SUPERUSER'],
                depot_parameter: ['granted ALTER SYSTEM on parameter "archive_command"'],
                depot_database: ['owner of database "depot_db"'],
                depot_tablespace: ['owner of tablespace "depot_space"'],
                depot_under_boss: ['member of "wharf_boss"'],
                depot_program: ['member of "pg_execute_server_program"'],
                depot_chain: ['member of "pg_read_server_files"', 'member of "wharf_middle"'],
                depot_via_named: ['member of "pg_execute_server_program"'],
            })
            expect(
                shownRefused(found.filter((role) => role.rolname === 'depot_chain' || role.rolname === 'depot_ok')),
            ).toBe('"depot_chain" (member of "pg_read_server_files", member of "wharf_middle")')
        } finally {
            await db.destroy()
        }
    }, 30_000)

    // Every later owner is handed ADMIN on app_user too. It is shared by every database on a server, so it may be a
    // member of a role another app named (CI's one contract server), but never of a predefined one or of one not
    // ordinary in shape.
    it('reads app_user too, first: each attribute and catalog entry refused, and every membership but the named roles and roles ordinary in shape', async () => {
        const db = new Kysely<DB>({ dialect: new PGliteDialect(openPglite()) })
        try {
            for (const statement of [
                'CREATE ROLE app_user NOLOGIN',
                'CREATE ROLE harbor_clerk NOLOGIN',
                // Another app's ordinary role, which this app does not name.
                'CREATE ROLE other_app_reader NOLOGIN',
                'CREATE ROLE wharf_boss NOLOGIN SUPERUSER',
                'CREATE ROLE wharf_middle NOLOGIN',
                'GRANT pg_read_server_files TO wharf_middle',
                'CREATE ROLE rds_fixture NOLOGIN',
                // One role per attribute, each reached only through app_user's membership in it.
                'CREATE ROLE wharf_bypass NOLOGIN BYPASSRLS',
                'CREATE ROLE wharf_replication NOLOGIN REPLICATION',
                'CREATE ROLE wharf_createrole NOLOGIN CREATEROLE',
                'CREATE ROLE wharf_createdb NOLOGIN CREATEDB',
                'CREATE ROLE wharf_login LOGIN',
                // ...and one per catalog entry, each attribute-free.
                'CREATE ROLE wharf_parameter NOLOGIN',
                'GRANT SET ON PARAMETER log_statement TO wharf_parameter',
                'CREATE ROLE wharf_database NOLOGIN',
                'CREATE DATABASE wharf_db OWNER wharf_database',
                'CREATE ROLE wharf_tablespace NOLOGIN',
                'SET allow_in_place_tablespaces = on',
                "CREATE TABLESPACE wharf_space OWNER wharf_tablespace LOCATION ''",
                'GRANT ALTER SYSTEM ON PARAMETER archive_command TO app_user',
                'ALTER ROLE app_user SUPERUSER BYPASSRLS REPLICATION CREATEROLE CREATEDB LOGIN',
                'GRANT harbor_clerk TO app_user',
                'GRANT other_app_reader TO app_user',
                'GRANT wharf_boss TO app_user',
                'GRANT wharf_middle TO app_user',
                'GRANT rds_fixture TO app_user',
                'GRANT pg_execute_server_program TO app_user',
                'GRANT wharf_bypass, wharf_replication, wharf_createrole, wharf_createdb, wharf_login TO app_user',
                'GRANT wharf_parameter, wharf_database, wharf_tablespace TO app_user',
                // A named role that is a member of app_user: what app_user leads to is app_user's to answer for.
                'CREATE ROLE depot_ok NOLOGIN',
                'GRANT app_user TO depot_ok',
            ]) {
                await sql.raw(statement).execute(db)
            }
            const found = await refusedOf(db, ['harbor_clerk', 'depot_ok'])
            expect(found.map((role) => [role.rolname, role.refused])).toEqual([
                [
                    'app_user',
                    [
                        'SUPERUSER',
                        'BYPASSRLS',
                        'REPLICATION',
                        'CREATEROLE',
                        'CREATEDB',
                        'LOGIN',
                        'granted ALTER SYSTEM on parameter "archive_command"',
                        'member of "pg_execute_server_program"',
                        'member of "pg_read_server_files"',
                        'member of "rds_fixture"',
                        'member of "wharf_boss"',
                        'member of "wharf_bypass"',
                        'member of "wharf_createdb"',
                        'member of "wharf_createrole"',
                        'member of "wharf_database"',
                        'member of "wharf_login"',
                        'member of "wharf_parameter"',
                        'member of "wharf_replication"',
                        'member of "wharf_tablespace"',
                    ],
                ],
                ['harbor_clerk', []],
                ['depot_ok', []],
            ])

            // Ordinary again, with the other app's role and a named one still granted: nothing refused.
            for (const statement of [
                'ALTER ROLE app_user NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEROLE NOCREATEDB NOLOGIN',
                'REVOKE wharf_boss, wharf_middle, rds_fixture, pg_execute_server_program FROM app_user',
                'REVOKE wharf_bypass, wharf_replication, wharf_createrole, wharf_createdb, wharf_login FROM app_user',
                'REVOKE wharf_parameter, wharf_database, wharf_tablespace FROM app_user',
                'REVOKE ALTER SYSTEM ON PARAMETER archive_command FROM app_user',
            ]) {
                await sql.raw(statement).execute(db)
            }
            expect(shownRefused(await refusedOf(db, ['harbor_clerk', 'depot_ok']))).toBe('')
            // ...and with no role named at all, as an app that creates none on a server another app's suite migrated.
            expect(await refusedOf(db, [])).toEqual([{ rolname: 'app_user', refused: [] }])
        } finally {
            await db.destroy()
        }
    }, 30_000)
})

describe('appRoles, read from a migrations module', () => {
    it('is none where the module exports none, as an app that creates no role', () => {
        expect(appRolesOf({ appMigrations: {} })).toEqual([])
    })

    it('is the names the module exports', () => {
        expect(appRolesOf({ appMigrations: {}, appRoles: ['harbor_clerk', 'depot_auditor'] as const })).toEqual([
            'harbor_clerk',
            'depot_auditor',
        ])
    })

    it('refuses anything but an array of distinct, lowercase, unquoted role names', () => {
        expect(() => checkAppRoles('harbor_clerk')).toThrow(/must be an array/)
        expect(() => checkAppRoles([42])).toThrow(/42|number.*not a role name/)
        expect(() => checkAppRoles(['Harbor_Clerk'])).toThrow(/"Harbor_Clerk" is not a role name/)
        expect(() => checkAppRoles(['harbor clerk'])).toThrow(/not a role name/)
        expect(() => checkAppRoles([`h${'x'.repeat(63)}`])).toThrow(/not a role name/)
        expect(() => checkAppRoles(['harbor_clerk', 'harbor_clerk'])).toThrow(/names "harbor_clerk" twice/)
    })

    it("refuses the framework's role, Postgres's predefined ones and Amazon RDS's", () => {
        for (const role of ['app_user', 'pg_read_all_data', 'rds_superuser']) {
            expect(() => checkAppRoles([role]), role).toThrow(new RegExp(`"${role}" is not the app's own role`))
        }
    })
})
