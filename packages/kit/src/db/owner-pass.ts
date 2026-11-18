import { randomUUID } from 'node:crypto'
import { type Kysely, sql } from 'kysely'
import {
    appRoles,
    checkAppRoles,
    FRAMEWORK_ROLE,
    ORDINARY_APP_USER,
    ORDINARY_NAMED,
    refusedOf,
    shownRefused,
} from './app-roles'
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
 * creator's membership in it too, as in `app_user` (`grantAppRoles`), and on no role the app does not name, nor on a
 * named role, or an `app_user`, that is not ordinary; after the migrations, `app_user` and every named role must still
 * be ordinary. Teardown leaves the roles themselves, as it leaves `app_user` (a role a migration creates is the
 * cluster's, not the pass's), but not what the owner granted on them: `DROP OWNED BY` revokes a membership the owner's migration granted (`GRANT <role> TO
 * app_user`), which would otherwise keep the owner from being dropped (`dropPassRole`). An owner the teardown cannot
 * drop fails the pass.
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
 * It refuses, before granting anything, a named role that is not ORDINARY (`refusedOf`, ./app-roles.ts): one that
 * can log in, create databases or roles, is a superuser, bypasses RLS or replicates, holds a privilege on a server
 * parameter, owns a database or tablespace, or is a member, at any depth, of any role but `app_user` and the other
 * named roles. ADMIN lets its holder grant itself SET on the role and so act as the role and everything it is a member
 * of, and, with CREATEROLE, reset a LOGIN role's password: on such a role it gives the owner more than
 * an app's own role, and the names alone (validated again here by `checkAppRoles`, as a caller may pass any list)
 * cannot rule that out on a server another hand set up. It refuses an existing `app_user` that is not ordinary the same
 * way, though it does not grant it: `runOwnerPass` grants `app_user` only once this has passed.
 */
export async function grantAppRoles(admin: Kysely<DB>, owner: string, named: readonly string[]): Promise<void> {
    const found = await refusedOf(admin, checkAppRoles(named))
    const privileged = shownRefused(found)
    if (privileged !== '') {
        throw new Error(
            `owner pass: refusing to grant ADMIN on ${privileged}: a later owner is handed ADMIN on app_user and on ` +
                'every role appRoles names, so each must be an ordinary role, and ADMIN on this one would give the owner ' +
                `more than that. Leave a named role ${ORDINARY_NAMED}, or stop naming it in appRoles; leave app_user ` +
                `${ORDINARY_APP_USER}.`,
        )
    }
    for (const { rolname } of found) {
        if (rolname === FRAMEWORK_ROLE) continue
        await sql`GRANT ${sql.id(rolname)} TO ${sql.id(owner)} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`.execute(admin)
    }
}

/**
 * Drops a role the pass created, if it is there: `DROP OWNED BY` first, on `admin`'s database, which revokes what the
 * role GRANTED as well as what it was granted, the role memberships it granted included (a migration's
 * `GRANT <app role> TO app_user`, run as the owner, makes the owner that membership's grantor, a dependency `DROP ROLE`
 * refuses to break), then `DROP ROLE`. Objects the role owns in another database still block it, so the caller drops
 * that database first. Throws when the role is still there.
 */
export async function dropPassRole(admin: Kysely<DB>, role: string): Promise<void> {
    const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ${role}`.execute(
        admin,
    )
    if (rows[0]!.n === 0) return
    await sql`DROP OWNED BY ${sql.id(role)}`.execute(admin)
    await sql`DROP ROLE ${sql.id(role)}`.execute(admin)
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
    // ONE teardown for everything from CREATE ROLE on, run whatever happened: a failure at any step must not leave a
    // LOGIN CREATEROLE role (which may hold ADMIN on app_user and the app's roles) on a server that outlives the run.
    let failed: { error: unknown } | undefined
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

            // Every cluster-wide role the APP's migrations create, which it names in `appRoles` (./app-roles.ts): a
            // later owner's migration that alters one needs the ADMIN its creator holds. FIRST, because it refuses an
            // existing app_user or named role that is not ordinary before anything at all is granted.
            await grantAppRoles(admin, owner, roles)
            // ...and `app_user`, which is cluster-wide too. Where it does not exist yet, the owner's own migration 0001
            // creates it and the owner gets the creator's membership just measured. Where another pass
            // already created it, the owner is granted EXACTLY that membership, so it stands where Aurora's
            // master user stands after creating app_user either way.
            const existing = await sql<{ n: number }>`
                SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'app_user'`.execute(admin)
            if (existing.rows[0]!.n > 0) {
                await sql`GRANT app_user TO ${sql.id(owner)} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`.execute(admin)
            }

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
        // ...and app_user and every named role are still ordinary. The owner's migration ran with ADMIN and CREATEROLE
        // on each, which let it make one LOGIN with a password it chose, CREATEDB or CREATEROLE, or (granting itself SET
        // on it) the owner of the pass's own database, by `ALTER DATABASE … OWNER TO` (`CREATE DATABASE` cannot run in
        // the migrations' transaction); never SUPERUSER, BYPASSRLS or REPLICATION, which the owner lacks, nor a
        // holder of a parameter privilege or a tablespace, which need a superuser (all measured on Postgres 18.4): a role
        // every later owner is handed ADMIN on must not be one.
        const strayed = shownRefused(await refusedOf(admin, roles))
        if (strayed !== '') {
            throw new Error(
                `owner pass: after the migrations, not an ordinary role: ${strayed}. Every later owner is handed ` +
                    `ADMIN on app_user and on every role appRoles names. Leave a named role ${ORDINARY_NAMED}; leave ` +
                    `app_user ${ORDINARY_APP_USER}.`,
            )
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
    } catch (error) {
        failed = { error }
    }
    await ownerDb?.destroy().catch(() => undefined)
    await superDb?.destroy().catch(() => undefined)
    // Every step runs, each on its own. The database goes first (what the owner owns there would block its drop),
    // best effort: a role it leaves behind is reported below.
    await sql`DROP DATABASE IF EXISTS ${sql.id(database)} WITH (FORCE)`.execute(admin).catch(() => undefined)
    const leaked: string[] = []
    for (const role of [probe, owner]) {
        await dropPassRole(admin, role).catch((error: unknown) => {
            leaked.push(`"${role}" (${error instanceof Error ? error.message : String(error)})`)
        })
    }
    // A role left behind is a failure of its own: the owner may log in, create roles, and holds ADMIN on app_user and
    // the app's roles, on a server that outlives the run. It never hides the pass's own failure: both are reported, and
    // Vitest (4.1) prints each error an AggregateError holds on its own, an assertion's expected/actual diff included.
    if (leaked.length > 0) {
        const teardown = new Error(`owner pass: teardown left ${leaked.join(', ')} on the server; drop it by hand`)
        if (failed) {
            throw new AggregateError(
                [failed.error, teardown],
                `${failed.error instanceof Error ? failed.error.message : String(failed.error)}\n...and ${teardown.message}`,
            )
        }
        throw teardown
    }
    if (failed) throw failed.error
}
