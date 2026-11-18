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
 */

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

function shown(value: unknown): string {
    if (typeof value === 'string') return JSON.stringify(value)
    if (Array.isArray(value)) return 'an array'
    return value === null ? 'null' : typeof value
}
