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
 * Read with `in` on the module namespace, because the seam need not declare it: the starter's does not, and each app's
 * typecheck compiles the framework against that app's own seam (`apps/starter/tsconfig.json` includes
 * `packages/kit/src`; reading `.appRoles` directly fails both apps' `tsc` with TS2339).
 *
 * An app's role is ORDINARY (`refusedOf`): it cannot log in, create databases or roles, is no superuser and bypasses
 * no RLS, holds no privilege on a server parameter and owns no database or tablespace, and it is a member of no role but
 * `app_user` and the app's other named roles, at any depth. ADMIN on a role lets its holder grant itself SET on it, and
 * so act as that role and as every role it is a member of: ADMIN on a role that is a member of a superuser, of
 * `pg_execute_server_program` or of `rds_superuser`, or that may `ALTER SYSTEM SET archive_command`, is that role's
 * power, not the app's. `app_user`, on which every later owner gets ADMIN too, is held to the same, and may be a member
 * of the named roles and of any role ordinary in shape, which another app on the same server may have granted it.
 */

import { type Kysely, sql } from 'kysely'
import type { DB } from './schema'

/** The framework's own role, which migration 0001 creates and the owner pass grants a later owner ADMIN on itself. */
export const FRAMEWORK_ROLE = 'app_user'

/** What an app's role is named: an unquoted Postgres identifier, lowercase, within its 63 characters. */
const ROLE_NAME = /^[a-z][a-z0-9_]{0,62}$/

/** Where an app names its roles, as every message says it. */
export const APP_ROLES_HOME =
    'export `appRoles` from `src/app-config/db/migrations.ts` (`@sssb/app-config/db/migrations`; ' +
    '`src/app-config/db/migrations/index.ts` when the migrations are a directory)'

/** What `refusedOf` holds every role to, as every message says it: the attributes and the catalogs. */
const ORDINARY_ALONE =
    'NOLOGIN, with no other attribute (CREATEDB, CREATEROLE, SUPERUSER, BYPASSRLS, REPLICATION), no privilege on a ' +
    'server parameter, no database or tablespace of its own'

/** What `refusedOf` holds a named role to, as every message says it. */
export const ORDINARY_NAMED = `${ORDINARY_ALONE}, and a member of no role but app_user and the app's other named roles, at any depth`

/** What `refusedOf` holds `app_user` to, as every message says it. */
export const ORDINARY_APP_USER =
    `${ORDINARY_ALONE}, and a member of no role but the app's named roles and roles ordinary in shape (none of the ` +
    'above, and no pg_* or rds_* role), at any depth'

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

/** A role that exists on a server, and what makes it more than an ordinary role there (none when it is one). */
export interface FoundRole {
    rolname: string
    refused: string[]
}

/**
 * Reads `app_user` and each named role that exists on the server `db` reaches (every role a later owner is handed
 * ADMIN on), with what makes it more than ordinary. A role that does not exist is left out; `app_user` comes first.
 *
 * None may hold SUPERUSER, BYPASSRLS, REPLICATION, CREATEROLE, CREATEDB or LOGIN, nor what the cluster-wide catalogs
 * record for it: a privilege on a server parameter (`pg_parameter_acl`: `GRANT ALTER SYSTEM ON PARAMETER ...`), or a
 * database or tablespace it owns (`pg_database.datdba`, `pg_tablespace.spcowner`). Its memberships, at any depth through
 * `pg_auth_members` and whatever their INHERIT and SET options say (ADMIN on the role lets its holder grant itself
 * both), are read as `member of "<role>"`, by two rules:
 *
 * - A NAMED role may be a member of `app_user` and of the other named roles only. Its walk stops at `app_user`, which
 *   is read on its own: what `app_user` is a member of is held to `app_user`'s rule.
 * - `app_user` may be a member of the named roles, and of a role that is ordinary in shape: none of the six attributes,
 *   none of those catalog entries, and none of Postgres's predefined roles (`pg_*`) or Amazon RDS's (`rds_*`), at any
 *   depth. It is shared by every
 *   database on the server, so where several apps' suites share one (CI's `CONTRACT_DATABASE_URL`), it is a member of
 *   the roles OTHER apps' migrations granted it, which this app does not name and cannot.
 */
export async function refusedOf(db: Kysely<DB>, named: readonly string[]): Promise<FoundRole[]> {
    const allowed = new Set([FRAMEWORK_ROLE, ...named])
    const found: FoundRole[] = []
    for (const role of new Set([FRAMEWORK_ROLE, ...named])) {
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
        // What the cluster-wide catalogs record for it, readable from any database by any role.
        const held = await sql<{ reason: string }>`
            WITH me AS (SELECT oid FROM pg_roles WHERE rolname = ${role})
            SELECT reason FROM (
                SELECT 1 AS k, p.parname AS n,
                       'granted ' || a.privilege_type || ' on parameter "' || p.parname || '"' AS reason
                FROM pg_parameter_acl p, aclexplode(p.paracl) a, me WHERE a.grantee = me.oid
                UNION ALL
                SELECT 2, d.datname, 'owner of database "' || d.datname || '"'
                FROM pg_database d, me WHERE d.datdba = me.oid
                UNION ALL
                SELECT 3, t.spcname, 'owner of tablespace "' || t.spcname || '"'
                FROM pg_tablespace t, me WHERE t.spcowner = me.oid
            ) catalog ORDER BY k, n, reason`.execute(db)
        // Every role this one is a member of, directly or through another, never through app_user (read on its own):
        // UNION, not UNION ALL, so a role reached twice is followed once. `shaped`: ordinary in shape, as above.
        const memberships = await sql<{ rolname: string; shaped: boolean }>`
            WITH RECURSIVE up(roleid) AS (
                SELECT m.roleid FROM pg_auth_members m JOIN pg_roles me ON me.oid = m.member WHERE me.rolname = ${role}
                UNION
                SELECT m.roleid FROM pg_auth_members m
                JOIN up ON m.member = up.roleid
                JOIN pg_roles via ON via.oid = up.roleid AND via.rolname <> ${FRAMEWORK_ROLE}
            )
            SELECT r.rolname,
                   NOT (r.rolsuper OR r.rolbypassrls OR r.rolreplication OR r.rolcreaterole OR r.rolcreatedb
                        OR r.rolcanlogin OR starts_with(r.rolname, 'pg_') OR starts_with(r.rolname, 'rds_')
                        OR EXISTS (SELECT FROM pg_parameter_acl p, aclexplode(p.paracl) a WHERE a.grantee = r.oid)
                        OR EXISTS (SELECT FROM pg_database d WHERE d.datdba = r.oid)
                        OR EXISTS (SELECT FROM pg_tablespace t WHERE t.spcowner = r.oid)) AS shaped
            FROM up JOIN pg_roles r ON r.oid = up.roleid ORDER BY r.rolname`.execute(db)
        const refused = [
            row.rolsuper && 'SUPERUSER',
            row.rolbypassrls && 'BYPASSRLS',
            row.rolreplication && 'REPLICATION',
            row.rolcreaterole && 'CREATEROLE',
            row.rolcreatedb && 'CREATEDB',
            row.rolcanlogin && 'LOGIN',
            ...held.rows.map((entry) => entry.reason),
            ...memberships.rows
                .filter((membership) =>
                    role === FRAMEWORK_ROLE
                        ? !named.includes(membership.rolname) && !membership.shaped
                        : !allowed.has(membership.rolname),
                )
                .map((membership) => `member of "${membership.rolname}"`),
        ].filter((reason): reason is string => typeof reason === 'string')
        found.push({ rolname: row.rolname, refused })
    }
    return found
}

/** The roles `refusedOf` found more than ordinary, as one clause: `"a" (LOGIN), "b" (member of "c")`. */
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
