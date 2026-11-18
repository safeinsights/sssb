import { randomUUID } from 'node:crypto'
import { type Kysely, sql } from 'kysely'
import { appRoles, checkAppRoles } from './app-roles'
import { migrateToLatest } from './migrate'
import { runRlsProofs } from './rls-proof-runner'
import type { ProofExpectation } from './rls-proofs'
import type { DB } from './schema'
import { runWithTenant } from './with-tenant'

/**
 * THE NON-SUPERUSER PASS of the contract suite: SSSB's migrations and its RLS proofs, run the way a
 * real deployment runs them — as a database OWNER that is not a superuser (ADR-0004 addendum,
 * 2026-11-16).
 *
 * Why it exists. Every other contract pass connects as `postgres`, a superuser, and a superuser may
 * `SET ROLE` to any role. Aurora's master user is `NOSUPERUSER CREATEROLE`, and since Postgres 16 a
 * non-superuser that creates a role is granted ADMIN on it, but not SET. So the owner that created
 * `app_user` could not switch to it, and every `withTenant` failed closed with `permission denied to set
 * role "app_user"`. No gate could see it, because every gate was a superuser.
 *
 * The app's own roles. `app_user` is not the only cluster-wide role a migration may create: an app's may create its
 * own, which it names in `appRoles` (./app-roles.ts). Where an earlier pass created one, a later owner is granted the
 * creator's membership in it too, as in `app_user` (`grantAppRoles`), and on no role the app does not name. Teardown
 * leaves them, as it leaves `app_user`: a role a migration creates is the cluster's, not the pass's.
 *
 * How it is built, so another transport can run it. The pass only ever reaches the server through
 * `admin` and `connect`, and migrates through `migrate`. The `pg` contract run (../adapters/real/db.contract.test.ts)
 * hands it pooled `pg` connections. The Data API run (../adapters/real/rds-data.contract.test.ts) hands it
 * Data API connections through the emulator, and its own migrate: the Data API runs every migration in
 * one transaction that takes a transaction-scoped lock first (ADR-0002, addendum 2026-11-16).
 */

/** A login to one database. */
export interface Login {
    database: string
    user: string
    password: string
}

export interface OwnerPassConnections {
    /** A SUPERUSER connection to a database that already exists on the server: it creates the owner. */
    admin: Kysely<DB>
    /** The superuser's own login: the privileged handle the proofs seed and run the negative control with. */
    superuser: { user: string; password: string }
    /** A database that already exists, for the owner to connect to while it creates its own. */
    maintenanceDatabase: string
    /** Open a connection for a login, through whichever transport this pass is proving. */
    connect: (login: Login) => Kysely<DB>
    /** Run the migrations on a connection `connect` opened, the way that transport does; `migrateToLatest` when omitted. */
    migrate?: (db: Kysely<DB>) => Promise<void>
}

/**
 * Grants `owner` the creator's membership — ADMIN, and neither INHERIT nor SET — in each of the app's named roles
 * (`appRoles`, ./app-roles.ts) that ALREADY exists on the server, as the pass does for `app_user`. A named role that
 * does not exist yet is the owner's own migration's to create, and the owner gets that membership by creating it. A
 * role that is not named is never touched.
 *
 * It refuses, before granting anything, a named role that holds more than an app's ordinary role may: a superuser, or a
 * role with BYPASSRLS, REPLICATION or CREATEROLE. ADMIN on such a role would hand the owner more than ADMIN on the
 * app's own role, and the names alone (validated by `checkAppRoles`) cannot rule it out on a server another hand set up.
 */
export async function grantAppRoles(admin: Kysely<DB>, owner: string, named: readonly string[]): Promise<void> {
    const roles = checkAppRoles(named)
    const found: { rolname: string; refused: string[] }[] = []
    for (const role of roles) {
        const { rows } = await sql<{
            rolname: string
            rolsuper: boolean
            rolbypassrls: boolean
            rolreplication: boolean
            rolcreaterole: boolean
        }>`
            SELECT rolname, rolsuper, rolbypassrls, rolreplication, rolcreaterole
            FROM pg_roles WHERE rolname = ${role}`.execute(admin)
        const row = rows[0]
        if (!row) continue
        const refused = [
            row.rolsuper && 'SUPERUSER',
            row.rolbypassrls && 'BYPASSRLS',
            row.rolreplication && 'REPLICATION',
            row.rolcreaterole && 'CREATEROLE',
        ].filter((attribute): attribute is string => typeof attribute === 'string')
        found.push({ rolname: row.rolname, refused })
    }
    const privileged = found.filter((role) => role.refused.length > 0)
    if (privileged.length > 0) {
        throw new Error(
            'owner pass: refusing to grant ADMIN on ' +
                privileged.map((role) => `"${role.rolname}" (${role.refused.join(', ')})`).join(', ') +
                ', which appRoles names: an app names only its own ordinary roles, and ADMIN on this one would give the ' +
                'owner more than that. Create the role without those attributes, or stop naming it in appRoles.',
        )
    }
    for (const { rolname } of found) {
        await sql`GRANT ${sql.id(rolname)} TO ${sql.id(owner)} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`.execute(admin)
    }
}

export async function runOwnerPass(
    connections: OwnerPassConnections,
    expect: (actual: unknown) => ProofExpectation,
): Promise<void> {
    const { admin, connect } = connections
    // Read before anything is created, so an invalid `appRoles` fails the pass with nothing to tear down.
    const roles = await appRoles()
    const stamp = Date.now()
    const owner = `sssb_owner_${stamp}`
    const probe = `${owner}_probe`
    const database = `sssb_owner_db_${stamp}`
    // Random, so a role a failed run left behind on a reused server cannot be logged into by its name.
    const login = { user: owner, password: randomUUID() }

    let ownerDb: Kysely<DB> | undefined
    let superDb: Kysely<DB> | undefined
    // ONE teardown for everything from CREATE ROLE on: a failure at any step must not leave a LOGIN
    // CREATEROLE role (which may hold ADMIN on app_user) on a server that outlives the run.
    try {
        // Aurora's master user, as a role: may log in, create roles and databases, and is no superuser.
        await sql`CREATE ROLE ${sql.id(owner)} LOGIN CREATEROLE CREATEDB NOSUPERUSER PASSWORD ${sql.lit(login.password)}`.execute(
            admin,
        )

        const bootstrap = connect({ ...login, database: connections.maintenanceDatabase })
        try {
            // What THIS server gives a non-superuser for a role it creates, measured rather than assumed:
            // the owner creates a throwaway role, and its own membership in it is read back. On Postgres 16+
            // with `createrole_self_grant` unset, that is ADMIN, and neither INHERIT nor SET.
            await sql`CREATE ROLE ${sql.id(probe)} NOLOGIN`.execute(bootstrap)
            const creator = await sql<{ admin_option: boolean; inherit_option: boolean; set_option: boolean }>`
                SELECT m.admin_option, m.inherit_option, m.set_option
                FROM pg_auth_members m
                JOIN pg_roles r ON r.oid = m.roleid AND r.rolname = ${probe}
                JOIN pg_roles me ON me.oid = m.member AND me.rolname = current_user`.execute(bootstrap)
            expect(creator.rows.length).toBe(1)
            expect(creator.rows[0]!.admin_option).toBe(true)
            expect(creator.rows[0]!.inherit_option).toBe(false)
            expect(creator.rows[0]!.set_option).toBe(false)

            // `app_user` is cluster-wide. Where it does not exist yet, the owner's own migration 0001
            // creates it and the owner gets the creator's membership just measured. Where another pass
            // already created it, the owner is granted EXACTLY that membership, so it stands where Aurora's
            // master user stands after creating app_user either way.
            const existing = await sql<{ n: number }>`
                SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'app_user'`.execute(admin)
            if (existing.rows[0]!.n > 0) {
                await sql`GRANT app_user TO ${sql.id(owner)} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`.execute(admin)
            }
            // ...and the same for every cluster-wide role the APP's migrations create, which it names in `appRoles`
            // (./app-roles.ts): a later owner's migration that alters one needs the ADMIN its creator holds.
            await grantAppRoles(admin, owner, roles)

            await sql`CREATE DATABASE ${sql.id(database)}`.execute(bootstrap)
        } finally {
            await bootstrap.destroy()
        }

        ownerDb = connect({ ...login, database })
        superDb = connect({ ...connections.superuser, database })

        // The pass proves what it says only if the owner really is no superuser and cannot bypass RLS.
        const self = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>`
            SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`.execute(ownerDb)
        expect(self.rows[0]!.rolsuper).toBe(false)
        expect(self.rows[0]!.rolbypassrls).toBe(false)

        await (connections.migrate ?? migrateToLatest)(ownerDb)

        // Whichever branch each named role took, the owner now stands where its creator does: the role exists, and the
        // owner holds ADMIN on it.
        for (const role of roles) {
            const held = await sql<{ admin: boolean | null }>`
                SELECT bool_or(m.admin_option) AS admin FROM pg_auth_members m
                JOIN pg_roles r ON r.oid = m.roleid AND r.rolname = ${role}
                JOIN pg_roles me ON me.oid = m.member AND me.rolname = ${owner}`.execute(admin)
            // As text, so a failure names the role.
            expect(`ADMIN on ${role}: ${String(held.rows[0]?.admin ?? false)}`).toBe(`ADMIN on ${role}: true`)
        }

        // The failure itself, named: inside withTenant the owner IS app_user, in the tenant it asked for.
        const [tenant] = await superDb
            .insertInto('tenants')
            .values({ slug: `owner-pass-${stamp}`, name: 'Owner Pass' })
            .returning('id')
            .execute()
        const inside = await runWithTenant(ownerDb, tenant!.id, (trx) =>
            sql<{ role: string; tenant: string }>`
                SELECT current_user AS role, current_setting('app.current_tenant', true) AS tenant`.execute(trx),
        )
        expect(inside.rows[0]!.role).toBe('app_user')
        expect(inside.rows[0]!.tenant).toBe(tenant!.id)

        // ...and the whole composed proof suite, every role switch made by the owner.
        await runRlsProofs(superDb, expect, { appDb: ownerDb })
    } finally {
        await ownerDb?.destroy()
        await superDb?.destroy()
        // Best effort, each step on its own: a failed teardown must not mask the result.
        await sql`DROP DATABASE IF EXISTS ${sql.id(database)} WITH (FORCE)`.execute(admin).catch(() => undefined)
        await sql`DROP ROLE IF EXISTS ${sql.id(probe)}`.execute(admin).catch(() => undefined)
        await sql`DROP ROLE IF EXISTS ${sql.id(owner)}`.execute(admin).catch(() => undefined)
    }
}
