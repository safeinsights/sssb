import { describe, expect, it } from 'vitest'
import { appRolesOf, checkAppRoles } from './app-roles'

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
