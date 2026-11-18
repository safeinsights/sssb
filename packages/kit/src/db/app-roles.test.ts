import { Kysely, sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { openPglite, PGliteDialect } from '../adapters/fake/pglite-dialect'
import { appRolesOf, checkAppRoles, refusedOf, shownRefused } from './app-roles'
import type { DB } from './schema'

describe('an app role is ordinary, read from a server (pglite)', () => {
    it('refuses each attribute, and every membership but app_user and the named roles, at any depth', async () => {
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
                'depot_under_boss',
                'depot_program',
                'depot_chain',
                'depot_via_named',
                'depot_absent',
            ]
            const found = await refusedOf(db, named)
            expect(Object.fromEntries(found.map((role) => [role.rolname, role.refused]))).toEqual({
                harbor_clerk: [],
                depot_ok: [],
                depot_login: ['LOGIN'],
                depot_createdb: ['CREATEDB'],
                depot_createrole: ['CREATEROLE'],
                depot_bypass: ['BYPASSRLS'],
                depot_replication: ['REPLICATION'],
                depot_super: ['SUPERUSER'],
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
