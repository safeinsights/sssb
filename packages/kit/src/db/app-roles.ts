/**
 * THE APP'S OWN CLUSTER-WIDE ROLES: the roles an app's migrations create, which it names in an OPTIONAL export of its
 * `@sssb/app-config/db/migrations` module, beside `appMigrations`:
 *
 *     export const appRoles = ['fixture_docket_clerk'] as const
 *
 * A role is cluster-wide, like `app_user`: on a server an earlier owner has migrated, the role is already there, and a
 * later owner's migration that ALTERs it, or grants it to another role, needs the ADMIN option the earlier owner got by
 * creating it. The contract suite's owner pass (./owner-pass.ts) grants a later owner exactly that, on the roles named
 * here and on no other; the conformance suite's `app-roles` check holds the list to what the migrations really create
 * (../testing/conformance/db.ts). An app that creates no role exports nothing, and changes nothing.
 *
 * Read with `in` on the module namespace, because the seam need not declare it: the starter does not, and the
 * framework compiles against the starter's seam (`packages/kit/tsconfig.strict.json`).
 *
 * An app's role is ORDINARY (`refusedOf`): it cannot log in, create databases or roles, is no superuser and bypasses
 * no RLS, and it is a member of no role but `app_user` and the app's other named roles, at any depth. ADMIN on a role
 * lets its holder grant itself SET on it, and so act as every role that role is a member of: ADMIN on a role that is a
 * member of a superuser, of `pg_execute_server_program` or of `rds_superuser` is that role's power, not the app's.
 */

import { type Kysely, sql } from 'kysely'
import type { DB } from './schema'

/** The framework's own role, which migration 0001 creates and the owner pass handles itself. */
const FRAMEWORK_ROLE = 'app_user'

/** What an app's role is named: an unquoted Postgres identifier, lowercase, within its 63 characters. */
const ROLE_NAME = /^[a-z][a-z0-9_]{0,62}$/

/** Where an app names its roles, as every message says it. */
export const APP_ROLES_HOME =
    'export `appRoles` from `src/app-config/db/migrations.ts` (`@sssb/app-config/db/migrations`; ' +
    '`src/app-config/db/migrations/index.ts` when the migrations are a directory)'

/**
 * Validates an `appRoles` value: an array of distinct role names an app may own. Refuses a name that is not a
 * lowercase unquoted identifier, `app_user` (the framework's), a predefined role's prefix (`pg_`) and Amazon RDS's
 * (`rds_`): the owner pass grants ADMIN on every name here, so a name must only ever be the app's own.
 */
export function checkAppRoles(raw: unknown): readonly string[] {
    if (!Array.isArray(raw)) {
        throw new Error(`appRoles must be an array of role names (${APP_ROLES_HOME}); got ${shown(raw)}`)
    }
    const seen = new Set<string>()
    for (const role of raw as unknown[]) {
        if (typeof role !== 'string' || !ROLE_NAME.test(role)) {
            throw new Error(
                `appRoles: ${shown(role)} is not a role name an app may own: a lowercase unquoted Postgres ` +
                    'identifier (a letter, then letters, digits or underscores, at most 63 characters)',
            )
        }
        if (role === FRAMEWORK_ROLE || role.startsWith('pg_') || role.startsWith('rds_')) {
            throw new Error(
                `appRoles: "${role}" is not the app's own role (${FRAMEWORK_ROLE} is the framework's, pg_* are ` +
                    "Postgres's predefined roles and rds_* are Amazon RDS's); name only the roles the app's migrations create",
            )
        }
        if (seen.has(role)) throw new Error(`appRoles names "${role}" twice`)
        seen.add(role)
    }
    return [...seen]
}

/** The roles an app's migrations module names: its `appRoles`, validated, or none when it exports none. */
export function appRolesOf(seam: object): readonly string[] {
    return 'appRoles' in seam ? checkAppRoles(seam.appRoles) : []
}

/** The running app's named roles, read from its seam when called. */
export async function appRoles(): Promise<readonly string[]> {
    return appRolesOf(await import('@sssb/app-config/db/migrations'))
}

/** A named role that exists on a server, and what makes it more than an ordinary role there (none when it is one). */
export interface FoundRole {
    rolname: string
    refused: string[]
}

/**
 * Reads each named role that exists on the server `db` reaches, with what makes it more than an app's ordinary role:
 * SUPERUSER, BYPASSRLS, REPLICATION, CREATEROLE, CREATEDB or LOGIN, and `member of "<role>"` for every role it is a
 * member of, at any depth through `pg_auth_members`, other than `app_user` and the named roles themselves. A named role
 * that does not exist is left out. Membership counts whatever its INHERIT and SET options say: ADMIN on the named role
 * lets its holder grant itself both.
 */
export async function refusedOf(db: Kysely<DB>, named: readonly string[]): Promise<FoundRole[]> {
    const allowed = new Set([FRAMEWORK_ROLE, ...named])
    const found: FoundRole[] = []
    for (const role of named) {
        const { rows } = await sql<{
            rolname: string
            rolsuper: boolean
            rolbypassrls: boolean
            rolreplication: boolean
            rolcreaterole: boolean
            rolcreatedb: boolean
            rolcanlogin: boolean
        }>`
            SELECT rolname, rolsuper, rolbypassrls, rolreplication, rolcreaterole, rolcreatedb, rolcanlogin
            FROM pg_roles WHERE rolname = ${role}`.execute(db)
        const row = rows[0]
        if (!row) continue
        // Every role this one is a member of, directly or through another: UNION, not UNION ALL, so a role reached
        // twice is followed once.
        const memberships = await sql<{ rolname: string }>`
            WITH RECURSIVE up(roleid) AS (
                SELECT m.roleid FROM pg_auth_members m JOIN pg_roles me ON me.oid = m.member WHERE me.rolname = ${role}
                UNION
                SELECT m.roleid FROM pg_auth_members m JOIN up ON m.member = up.roleid
            )
            SELECT r.rolname FROM up JOIN pg_roles r ON r.oid = up.roleid ORDER BY r.rolname`.execute(db)
        const refused = [
            row.rolsuper && 'SUPERUSER',
            row.rolbypassrls && 'BYPASSRLS',
            row.rolreplication && 'REPLICATION',
            row.rolcreaterole && 'CREATEROLE',
            row.rolcreatedb && 'CREATEDB',
            row.rolcanlogin && 'LOGIN',
            ...memberships.rows
                .filter((membership) => !allowed.has(membership.rolname))
                .map((membership) => `member of "${membership.rolname}"`),
        ].filter((reason): reason is string => typeof reason === 'string')
        found.push({ rolname: row.rolname, refused })
    }
    return found
}

/** The named roles `refusedOf` found more than ordinary, as one clause: `"a" (LOGIN), "b" (member of "c")`. */
export function shownRefused(found: readonly FoundRole[]): string {
    return found
        .filter((role) => role.refused.length > 0)
        .map((role) => `"${role.rolname}" (${role.refused.join(', ')})`)
        .join(', ')
}

function shown(value: unknown): string {
    if (typeof value === 'string') return JSON.stringify(value)
    if (Array.isArray(value)) return 'an array'
    return value === null ? 'null' : typeof value
}
