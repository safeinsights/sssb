import { type Kysely, type KyselyPlugin, RawNode, sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, onTestFinished, test, vi } from 'vitest'
import { startContractServer, type ContractServer } from './contract-postgres'
import { randomUUID } from 'node:crypto'
import { migrateToLatest } from '../../db/migrate'
import { up as grantAppUser } from '../../db/migrations/0015_app_user_grant'
import { runWithTenant } from '../../db/with-tenant'
import { appRoles } from '../../db/app-roles'
import { dropPassRole, grantAppRoles, runOwnerPass } from '../../db/owner-pass'
import { runRlsProofs } from '../../db/rls-proof-runner'
import type { DB } from '../../db/schema'
import type { DbPort } from '../../ports/db'
import { createRealDb } from './db'

/**
 * SSSB's OWN contract run: the composed proof suite over the framework's fixture seam
 * (packages/kit/test-fixture), on real Postgres, through the REAL db adapter — so what is proven is the
 * pool configuration production runs (its `date` parser included), not a hand-built one.
 *
 * It needs its own database. The fixture's migrations share 0001–0999 with the contract app's but differ
 * from 1001 up, and two such sets over one database make Kysely report corrupted migrations. So it
 * creates `sssb_contract` on whichever server it is given: CONTRACT_DATABASE_URL's in CI, otherwise an
 * embedded-postgres of its own on CONTRACT_PG_PORT, the same derived port the apps' contract suites use —
 * `vitest.contract.config.ts` sets it and runs files one at a time, so two never hold that port together.
 *
 * The apps' contract runner (`@sssb/kit/testing/contract`) runs the generic passes over each app's tables; this file
 * keeps what is about the framework: the real adapter's pool, migration 0015 branch by branch, a second owner.
 */

const DATABASE = 'sssb_contract'

let server: ContractServer
let realDb: DbPort
/** The server's superuser URL (to its `postgres` database), kept for the non-superuser pass. */
let serverUrl: string

beforeAll(async () => {
    // The server, and `sssb_contract` on it: CONTRACT_DATABASE_URL's in CI, otherwise an embedded-postgres of its own
    // (./contract-postgres.ts, which every contract suite shares).
    server = await startContractServer('sssb-contract')
    serverUrl = server.url
    await server.createDatabase(DATABASE)

    const url = new URL(serverUrl)
    url.pathname = `/${DATABASE}`
    // Not migrated yet: the non-superuser pass below runs FIRST, so on a fresh server the owner's own
    // migration 0001 is what creates `app_user`, exactly as on a new Aurora cluster. The superuser pass
    // migrates `sssb_contract` when its turn comes.
    realDb = createRealDb(url.toString())
}, 120_000)

afterAll(async () => {
    await realDb?.getDb().destroy()
    await server?.stop()
})

/**
 * Drops each role a test made the owner pass's way (`dropPassRole`), in order, every one tried whatever the others did:
 * a role the first could not drop must not leave the next on the server too. Throws what failed, each failure kept.
 */
async function dropPassRoles(admin: Kysely<DB>, roles: readonly string[]): Promise<void> {
    const failures: unknown[] = []
    for (const role of roles) {
        await dropPassRole(admin, role).catch((error: unknown) => {
            failures.push(error)
        })
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1)
        throw new AggregateError(failures, `could not drop ${failures.length} of ${roles.join(', ')}`)
}

/** The owner pass's owners still on the server (`sssb_owner_<stamp>`, and their probes). */
async function ownersOn(admin: Kysely<DB>): Promise<string[]> {
    const { rows } = await sql<{ rolname: string }>`
        SELECT rolname FROM pg_roles WHERE starts_with(rolname, 'sssb_owner_') ORDER BY 1`.execute(admin)
    return rows.map((row) => row.rolname)
}

/**
 * That `outcome` is ONE error, the one `message` describes: not an AggregateError, which is what the pass throws when
 * its teardown also left an owner behind, and whose text would still contain the message.
 */
function expectOnly(outcome: unknown, message: string | RegExp): void {
    expect(outcome).toBeInstanceOf(Error)
    expect(outcome).not.toBeInstanceOf(AggregateError)
    expect((outcome as Error).message).toMatch(message)
}

/** A connection for a login on this server, through the REAL adapter (its pool, its `date` parser). */
function connect(login: { database: string; user: string; password: string }) {
    const url = new URL(serverUrl)
    url.username = encodeURIComponent(login.user)
    url.password = encodeURIComponent(login.password)
    url.pathname = `/${login.database}`
    return createRealDb(url.toString()).getDb()
}

describe('SSSB fixture seam on real Postgres, through the real adapter (contract)', () => {
    // FIRST, deliberately (vitest runs a file's tests in order). On a fresh server nothing has created `app_user`
    // yet, so the owner creates it itself; the next test runs the pass again on the same server, which takes the
    // branch a reused server takes (owner-pass.ts). A local run's embedded server is this file's own, so it is
    // always fresh here. On CI's shared service (CONTRACT_DATABASE_URL) another suite may have run first (the
    // contract runner's own over the fixture, ./contract-runner.contract.test.ts, sorts before this file), and then
    // both tests take the reused branch: the fresh branch is covered by whichever suite reached that server first,
    // since every suite's first owner pass takes it there.
    // The pass every other one cannot be: a NON-SUPERUSER owner, as Aurora's master user is, runs the
    // migrations and makes every role switch in the proofs (packages/kit/src/db/owner-pass.ts).
    test('a non-superuser owner migrates, and switches to app_user inside withTenant', async () => {
        const server = new URL(serverUrl)
        const admin = connect({
            database: server.pathname.slice(1) || 'postgres',
            user: decodeURIComponent(server.username),
            password: decodeURIComponent(server.password),
        })
        try {
            await runOwnerPass(
                {
                    admin,
                    superuser: {
                        user: decodeURIComponent(server.username),
                        password: decodeURIComponent(server.password),
                    },
                    maintenanceDatabase: server.pathname.slice(1) || 'postgres',
                    connect,
                },
                expect,
            )
        } finally {
            await admin.destroy()
        }
    })

    // ...and again, now that the first owner's migration has created `app_user`: the branch a reused
    // server takes, where the owner is granted the creator's measured membership instead.
    test('a non-superuser owner migrates where app_user already exists, and switches too', async () => {
        const server = new URL(serverUrl)
        const admin = connect({
            database: server.pathname.slice(1) || 'postgres',
            user: decodeURIComponent(server.username),
            password: decodeURIComponent(server.password),
        })
        try {
            const existing = await sql<{
                n: number
            }>`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'app_user'`.execute(admin)
            expect(existing.rows[0]!.n).toBe(1)
            // ...and so does the fixture's own role, which its migration 1004 alters: the owner needs ADMIN on it too.
            const named = await appRoles()
            expect(named).toEqual(['fixture_docket_clerk'])
            for (const role of named) {
                const { rows } = await sql<{
                    n: number
                }>`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ${role}`.execute(admin)
                expect(rows[0]!.n).toBe(1)
            }
            await runOwnerPass(
                {
                    admin,
                    superuser: {
                        user: decodeURIComponent(server.username),
                        password: decodeURIComponent(server.password),
                    },
                    maintenanceDatabase: server.pathname.slice(1) || 'postgres',
                    connect,
                },
                expect,
            )
        } finally {
            await admin.destroy()
        }
    })

    // Two databases on ONE cluster, migrated by different owners (staging and production on one Aurora
    // cluster): `app_user` is cluster-wide, so only whoever created it holds ADMIN. A second owner's
    // migration must stop at 0015 with the statement to run, roll back whole, and succeed once a role
    // holding ADMIN has run that statement VERBATIM.
    test('a second owner, with no ADMIN on an app_user someone else created, stops at 0015 with the remedy', async () => {
        const server = new URL(serverUrl)
        const superuser = { user: decodeURIComponent(server.username), password: decodeURIComponent(server.password) }
        const maintenance = server.pathname.slice(1) || 'postgres'
        const admin = connect({ ...superuser, database: maintenance })
        const stamp = Date.now()
        // Mixed case on purpose: the printed remedy must quote the name, or running it would name another role.
        const second = `Sssb_Second_${stamp}`
        const creator = `sssb_creator_${stamp}`
        const database = `sssb_second_db_${stamp}`
        const login = { user: second, password: randomUUID() }
        const creatorLogin = { user: creator, password: randomUUID() }
        let ownerDb: ReturnType<typeof connect> | undefined
        // The roles go once the test is over, whatever it did, and a role that cannot be dropped fails the test: the
        // second owner may log in and create roles, and its migration's 1004 granted the clerk to app_user (as the
        // owner pass's teardown, ../../db/owner-pass.ts). `second` first: the creator granted it app_user. Each is tried
        // whatever the other did, and every failure is reported.
        onTestFinished(async () => {
            try {
                await dropPassRoles(admin, [second, creator])
            } finally {
                await admin.destroy()
            }
        })
        try {
            // Someone else made app_user; this owner holds no membership in it at all. The role that runs
            // the remedy below holds what a creator holds (ADMIN only), not superuser.
            await sql`DO $$ BEGIN CREATE ROLE app_user NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`.execute(
                admin,
            )
            await sql`CREATE ROLE ${sql.id(creator)} LOGIN NOSUPERUSER PASSWORD ${sql.lit(creatorLogin.password)}`.execute(
                admin,
            )
            await sql`GRANT app_user TO ${sql.id(creator)} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`.execute(admin)
            await sql`CREATE ROLE ${sql.id(second)} LOGIN CREATEROLE CREATEDB NOSUPERUSER PASSWORD ${sql.lit(login.password)}`.execute(
                admin,
            )
            // The fixture's own role (its 1004 alters it) is granted as the owner pass grants it: this case is about
            // app_user, and a second owner needs the app's roles from whoever holds ADMIN on them just the same.
            await grantAppRoles(admin, second, await appRoles())
            const bootstrap = connect({ ...login, database: maintenance })
            try {
                await sql`CREATE DATABASE ${sql.id(database)}`.execute(bootstrap)
            } finally {
                await bootstrap.destroy()
            }
            ownerDb = connect({ ...login, database })

            const failure = await migrateToLatest(ownerDb).then(
                () => null,
                (error: unknown) => String(error),
            )
            expect(failure).toMatch(new RegExp(`SSSB: role ${second} cannot switch to app_user`))
            // Kysely runs every pending migration in one transaction, so nothing of the run survives: no
            // migration recorded, and no table the earlier migrations created.
            const executed = await sql<{ n: number }>`SELECT count(*)::int AS n FROM kysely_migration`.execute(ownerDb)
            expect(executed.rows[0]!.n).toBe(0)
            const tenants = await sql<{ t: string | null }>`SELECT to_regclass('public.tenants')::text AS t`.execute(
                ownerDb,
            )
            expect(tenants.rows[0]!.t).toBeNull()

            // The remedy, exactly as the error states it, run by the ADMIN-only creator.
            const remedy = /run: (GRANT app_user TO \S+ WITH SET TRUE, INHERIT FALSE)/.exec(failure ?? '')?.[1]
            expect(remedy).toBe(`GRANT app_user TO "${second}" WITH SET TRUE, INHERIT FALSE`)
            const creatorDb = connect({ ...creatorLogin, database: maintenance })
            try {
                await sql.raw(remedy!).execute(creatorDb)
            } finally {
                await creatorDb.destroy()
            }

            // Now 0015 finds the switch already effective and grants nothing; everything migrates.
            await migrateToLatest(ownerDb)
            const inside = await runWithTenant(ownerDb, randomUUID(), (trx) =>
                sql<{ role: string }>`SELECT current_user AS role`.execute(trx),
            )
            expect(inside.rows[0]!.role).toBe('app_user')
        } finally {
            await ownerDb?.destroy()
            await sql`DROP DATABASE IF EXISTS ${sql.id(database)} WITH (FORCE)`.execute(admin).catch(() => undefined)
        }
    })

    /** The server's superuser login, its maintenance database, and a superuser connection to `database` (that one). */
    function asSuperuser(database?: string) {
        const server = new URL(serverUrl)
        const superuser = { user: decodeURIComponent(server.username), password: decodeURIComponent(server.password) }
        const maintenanceDatabase = server.pathname.slice(1) || 'postgres'
        return {
            admin: connect({ ...superuser, database: database ?? maintenanceDatabase }),
            superuser,
            maintenanceDatabase,
        }
    }

    /**
     * Makes `role`, which exists and is ordinary, more than ordinary through one cluster-wide catalog: ALTER SYSTEM on
     * `archive_command` (a shell command the server runs), or the owner of a database or of a tablespace (in place, so
     * it needs no directory on the server's machine). Resolves to what the refusal names and what undoes it.
     */
    async function holdInCatalog(
        admin: ReturnType<typeof connect>,
        kind: 'parameter' | 'database' | 'tablespace',
        role: string,
    ): Promise<{ reason: string; undo: () => Promise<void> }> {
        const object = `${role}_${kind}`
        if (kind === 'parameter') {
            await sql`GRANT ALTER SYSTEM ON PARAMETER archive_command TO ${sql.id(role)}`.execute(admin)
            return {
                reason: 'granted ALTER SYSTEM on parameter "archive_command"',
                undo: async () => {
                    await sql`REVOKE ALTER SYSTEM ON PARAMETER archive_command FROM ${sql.id(role)}`.execute(admin)
                },
            }
        }
        if (kind === 'database') {
            await sql`CREATE DATABASE ${sql.id(object)} OWNER ${sql.id(role)}`.execute(admin)
            return {
                reason: `owner of database "${object}"`,
                undo: async () => {
                    await sql`DROP DATABASE IF EXISTS ${sql.id(object)} WITH (FORCE)`.execute(admin)
                },
            }
        }
        // One connection: the setting is the session's, and CREATE TABLESPACE runs in no transaction.
        await admin.connection().execute(async (session) => {
            await sql`SET allow_in_place_tablespaces = on`.execute(session)
            await sql`CREATE TABLESPACE ${sql.id(object)} OWNER ${sql.id(role)} LOCATION ''`.execute(session)
            await sql`RESET allow_in_place_tablespaces`.execute(session)
        })
        return {
            reason: `owner of tablespace "${object}"`,
            undo: async () => {
                await sql`DROP TABLESPACE IF EXISTS ${sql.id(object)}`.execute(admin)
            },
        }
    }
    const catalogKinds = ['parameter', 'database', 'tablespace'] as const

    /** The memberships `role` holds, as `<the role it is a member of>:<its ADMIN option>`. */
    const membershipsOf = async (admin: ReturnType<typeof connect>, role: string) =>
        (
            await sql<{ held: string }>`
                SELECT r.rolname || ':' || m.admin_option AS held FROM pg_auth_members m
                JOIN pg_roles r ON r.oid = m.roleid
                JOIN pg_roles me ON me.oid = m.member AND me.rolname = ${role}
                ORDER BY 1`.execute(admin)
        ).rows.map((row) => row.held)

    // The owner pass grants ADMIN on the roles an app names, and on nothing more: a named role that is more than an
    // app's ordinary role is refused before anything is granted, so a hostile or mistaken name cannot lift the owner.
    // ADMIN lets its holder grant itself SET on the role, so what the catalogs record for the role, and its memberships
    // at any depth, are its power too.
    test("the owner pass refuses ADMIN on a named role that is not ordinary: an attribute, a catalog entry, or a membership beyond app_user and the app's roles", async () => {
        const { admin } = asSuperuser()
        const stamp = Date.now()
        const owner = `sssb_refused_owner_${stamp}`
        const created: string[] = [owner]
        const undos: (() => Promise<void>)[] = []
        const role = async (name: string, ...statements: string[]) => {
            created.push(name)
            for (const statement of statements) await sql.raw(statement).execute(admin)
            return name
        }
        try {
            await sql`CREATE ROLE ${sql.id(owner)} NOLOGIN NOSUPERUSER CREATEROLE`.execute(admin)
            const boss = await role(`fixture_boss_${stamp}`, `CREATE ROLE fixture_boss_${stamp} NOLOGIN SUPERUSER`)
            const middle = await role(
                `fixture_middle_${stamp}`,
                `CREATE ROLE fixture_middle_${stamp} NOLOGIN`,
                `GRANT pg_read_server_files TO fixture_middle_${stamp}`,
            )
            // [what it is, the role, what the refusal names]
            const cases: [string, string, string][] = []
            for (const attribute of ['SUPERUSER', 'BYPASSRLS', 'REPLICATION', 'CREATEROLE', 'CREATEDB']) {
                const name = `fixture_${attribute.toLowerCase()}_${stamp}`
                cases.push([attribute, await role(name, `CREATE ROLE ${name} NOLOGIN ${attribute}`), attribute])
            }
            // A LOGIN role: ADMIN and CREATEROLE would let the owner reset its password, and log in as it.
            const login = `fixture_login_${stamp}`
            cases.push(['LOGIN', await role(login, `CREATE ROLE ${login} LOGIN`), 'LOGIN'])
            const underBoss = `fixture_under_boss_${stamp}`
            cases.push([
                'a member of a superuser role',
                await role(underBoss, `CREATE ROLE ${underBoss} NOLOGIN`, `GRANT ${boss} TO ${underBoss}`),
                `member of "${boss}"`,
            ])
            const program = `fixture_program_${stamp}`
            cases.push([
                'a member of pg_execute_server_program',
                await role(program, `CREATE ROLE ${program} NOLOGIN`, `GRANT pg_execute_server_program TO ${program}`),
                'member of "pg_execute_server_program"',
            ])
            // Two levels down: the role it is a member of is an ordinary-looking one, and what THAT is a member of is not.
            const chain = `fixture_chain_${stamp}`
            cases.push([
                'a member, two levels down, of pg_read_server_files',
                await role(chain, `CREATE ROLE ${chain} NOLOGIN`, `GRANT ${middle} TO ${chain}`),
                `member of "${middle}", member of "pg_read_server_files"`,
            ])
            // Attribute-free and a member of nothing: what the cluster-wide catalogs record for it is its power too.
            for (const kind of catalogKinds) {
                const name = await role(`fixture_${kind}_${stamp}`, `CREATE ROLE fixture_${kind}_${stamp} NOLOGIN`)
                const { reason, undo } = await holdInCatalog(admin, kind, name)
                undos.push(undo)
                cases.push([`a role with a ${kind} in the catalogs`, name, reason])
            }
            for (const [label, name, reasons] of cases) {
                // Named beside the fixture's ordinary role: the refusal grants neither.
                await expect(grantAppRoles(admin, owner, ['fixture_docket_clerk', name]), label).rejects.toThrow(
                    `refusing to grant ADMIN on "${name}" (${reasons}): a later owner is handed ADMIN`,
                )
            }
            expect(await membershipsOf(admin, owner)).toEqual([])

            // The names are validated again where they are granted, whoever passes them: a predefined role (whose own
            // attributes and memberships are all an ordinary role's) and the framework's role are never the app's.
            for (const name of ['pg_execute_server_program', 'app_user']) {
                await expect(grantAppRoles(admin, owner, [name]), name).rejects.toThrow(
                    `appRoles: "${name}" is not the app's own role`,
                )
            }
            expect(await membershipsOf(admin, owner)).toEqual([])

            // A named role that does not exist is the owner's migration's to create: nothing to grant, nothing refused.
            await grantAppRoles(admin, owner, [`fixture_absent_${stamp}`])
            expect(await membershipsOf(admin, owner)).toEqual([])

            // A named role that is a member of app_user and of another named role is ordinary, and is granted.
            const sibling = await role(
                `fixture_sibling_${stamp}`,
                `CREATE ROLE fixture_sibling_${stamp} NOLOGIN`,
                `GRANT app_user TO fixture_sibling_${stamp}`,
                `GRANT fixture_docket_clerk TO fixture_sibling_${stamp}`,
            )
            await grantAppRoles(admin, owner, ['fixture_docket_clerk', sibling])
            expect(await membershipsOf(admin, owner)).toEqual(['fixture_docket_clerk:true', `${sibling}:true`])
        } finally {
            for (const undo of undos) await undo()
            for (const name of created.reverse()) {
                await sql`DROP ROLE IF EXISTS ${sql.id(name)}`.execute(admin).catch(() => undefined)
            }
            await admin.destroy()
        }
    })

    /**
     * The owner pass, with `after` run once the owner's migrations have: on the owner's own connection, with the owner's
     * name and a superuser connection. Resolves to what the pass threw (null when it passed), the owner's name, and the
     * owner pass's roles it left on the server (none, unless its teardown failed).
     */
    async function ownerPassThen(
        after: (ownerDb: ReturnType<typeof connect>, owner: string, admin: ReturnType<typeof connect>) => Promise<void>,
    ) {
        const { admin, superuser, maintenanceDatabase } = asSuperuser()
        let owner = ''
        try {
            const before = await ownersOn(admin)
            const outcome = await runOwnerPass(
                {
                    admin,
                    superuser,
                    maintenanceDatabase,
                    connect,
                    migrate: async (ownerDb) => {
                        await migrateToLatest(ownerDb)
                        owner = (await sql<{ me: string }>`SELECT current_user AS me`.execute(ownerDb)).rows[0]!.me
                        await after(ownerDb, owner, admin)
                    },
                },
                expect,
            ).then(
                () => null,
                (error: unknown) => error,
            )
            const left = (await ownersOn(admin)).filter((role) => !before.includes(role))
            return { owner, outcome, left }
        } finally {
            await admin.destroy()
        }
    }

    // The migration itself runs as the owner, with ADMIN and CREATEROLE on the app's role: it can make that role LOGIN
    // with a password it chose, or CREATEDB. Once the migrations ran, the pass checks every named role is still ordinary,
    // and fails naming the role and what it gained.
    test('the owner pass fails when its migrations leave a named role able to log in, or to create databases', async () => {
        try {
            const { outcome, left } = await ownerPassThen(async (ownerDb) => {
                await sql`ALTER ROLE fixture_docket_clerk LOGIN CREATEDB PASSWORD 'known'`.execute(ownerDb)
            })
            expectOnly(outcome, 'after the migrations, not an ordinary role: "fixture_docket_clerk" (CREATEDB, LOGIN).')
            expect(left).toEqual([])
        } finally {
            const { admin } = asSuperuser()
            await sql`ALTER ROLE fixture_docket_clerk NOLOGIN NOCREATEDB PASSWORD NULL`.execute(admin)
            await admin.destroy()
        }
    })

    // ...or the owner of a database: ADMIN lets the owner grant itself SET on the role and then make the role a
    // database's owner. A migration would do it with `ALTER DATABASE … OWNER TO` (`CREATE DATABASE` cannot run in its
    // transaction); this test's hook runs after the migrations, outside their transaction, so it creates one (both
    // measured on Postgres 16.15 and 18.4). Every later owner could then act as that database's owner.
    test('the owner pass fails when its migrations leave a named role owning a database', async () => {
        const database = `fixture_clerk_owns_${Date.now()}`
        try {
            const { outcome, left } = await ownerPassThen(async (ownerDb, owner) => {
                await sql`GRANT fixture_docket_clerk TO ${sql.id(owner)} WITH SET TRUE`.execute(ownerDb)
                await sql`CREATE DATABASE ${sql.id(database)} OWNER fixture_docket_clerk`.execute(ownerDb)
            })
            expectOnly(
                outcome,
                `after the migrations, not an ordinary role: "fixture_docket_clerk" (owner of database "${database}").`,
            )
            expect(left).toEqual([])
        } finally {
            const { admin } = asSuperuser()
            await sql`DROP DATABASE IF EXISTS ${sql.id(database)} WITH (FORCE)`.execute(admin)
            await admin.destroy()
        }
    })

    // Whichever branch each named role took (created by the owner's migration, or granted before it), the owner holds
    // ADMIN on it after the migrations: the pass checks that, so a grant that stops reaching the owner is seen.
    test('the owner pass fails when the owner does not hold ADMIN on a named role after its migrations', async () => {
        const { outcome, left } = await ownerPassThen(async (_ownerDb, owner, admin) => {
            // CASCADE: the owner's migration granted the clerk to app_user on the strength of that ADMIN.
            await sql`REVOKE fixture_docket_clerk FROM ${sql.id(owner)} CASCADE`.execute(admin)
        })
        expectOnly(outcome, /ADMIN on fixture_docket_clerk: false/)
        expect(left).toEqual([])
    })

    // `app_user` is handed to every later owner with ADMIN as well, so the same rule holds it (`refusedOf`): before the
    // pass grants anything, and after the migrations. It may be a member of a role it does not name, provided that role
    // is ordinary in shape: on a server several apps' suites share, other apps' migrations grant it their roles.
    const ordinaryAppUser =
        'ALTER ROLE app_user NOSUPERUSER NOBYPASSRLS NOREPLICATION NOCREATEROLE NOCREATEDB NOLOGIN PASSWORD NULL'

    test('the owner pass refuses ADMIN on an app_user that is not ordinary, and grants nothing', async () => {
        const { admin } = asSuperuser()
        const stamp = Date.now()
        const owner = `sssb_refused_owner_${stamp}`
        const boss = `fixture_boss_${stamp}`
        const middle = `fixture_middle_${stamp}`
        const provider = `rds_fixture_${stamp}`
        const otherApp = `fixture_other_app_${stamp}`
        // One role per attribute, each reached only through app_user's membership in it (SUPERUSER is `boss`'s).
        const reached = ['BYPASSRLS', 'REPLICATION', 'CREATEROLE', 'CREATEDB', 'LOGIN'].map(
            (attribute): [string, string] => [attribute, `fixture_reached_${attribute.toLowerCase()}_${stamp}`],
        )
        // What a leaked owner pass leaves behind: a LOGIN CREATEROLE CREATEDB role, as the pass's owner is made.
        const leaked = `fixture_leaked_owner_${stamp}`
        // ...and one per cluster-wide catalog entry, attribute-free.
        const catalogued = catalogKinds.map((kind) => `fixture_reached_${kind}_${stamp}`)
        const undos: (() => Promise<void>)[] = []
        try {
            for (const statement of [
                `CREATE ROLE ${owner} NOLOGIN NOSUPERUSER CREATEROLE`,
                `CREATE ROLE ${boss} NOLOGIN SUPERUSER`,
                `CREATE ROLE ${middle} NOLOGIN`,
                `GRANT pg_read_server_files TO ${middle}`,
                `CREATE ROLE ${provider} NOLOGIN`,
                `CREATE ROLE ${otherApp} NOLOGIN`,
                ...reached.map(
                    ([attribute, name]) => `CREATE ROLE ${name} ${attribute === 'LOGIN' ? '' : 'NOLOGIN '}${attribute}`,
                ),
                `CREATE ROLE ${leaked} LOGIN CREATEROLE CREATEDB NOSUPERUSER`,
                ...catalogued.map((name) => `CREATE ROLE ${name} NOLOGIN`),
            ]) {
                await sql.raw(statement).execute(admin)
            }
            const held = catalogKinds.map((kind, index) => [kind, catalogued[index]!] as const)
            for (const [kind, name] of held) undos.push((await holdInCatalog(admin, kind, name)).undo)
            // [what app_user is made, the statement, the one that undoes it, what the refusal names]
            const cases: [string, string, string, string][] = [
                ...['SUPERUSER', 'BYPASSRLS', 'REPLICATION', 'CREATEROLE', 'CREATEDB', 'LOGIN'].map(
                    (attribute): [string, string, string, string] => [
                        attribute,
                        `ALTER ROLE app_user ${attribute}`,
                        ordinaryAppUser,
                        attribute,
                    ],
                ),
                [
                    'granted ALTER SYSTEM on archive_command',
                    'GRANT ALTER SYSTEM ON PARAMETER archive_command TO app_user',
                    'REVOKE ALTER SYSTEM ON PARAMETER archive_command FROM app_user',
                    'granted ALTER SYSTEM on parameter "archive_command"',
                ],
                [
                    'a member of pg_execute_server_program',
                    'GRANT pg_execute_server_program TO app_user',
                    'REVOKE pg_execute_server_program FROM app_user',
                    'member of "pg_execute_server_program"',
                ],
                [
                    'a member of a superuser role',
                    `GRANT ${boss} TO app_user`,
                    `REVOKE ${boss} FROM app_user`,
                    `member of "${boss}"`,
                ],
                ...reached.map(([attribute, name]): [string, string, string, string] => [
                    `a member of a ${attribute} role`,
                    `GRANT ${name} TO app_user`,
                    `REVOKE ${name} FROM app_user`,
                    `member of "${name}"`,
                ]),
                ...held.map(([kind, name]): [string, string, string, string] => [
                    `a member of a role with a ${kind} in the catalogs`,
                    `GRANT ${name} TO app_user`,
                    `REVOKE ${name} FROM app_user`,
                    `member of "${name}"`,
                ]),
                [
                    "a member of a leaked owner pass's owner",
                    `GRANT ${leaked} TO app_user`,
                    `REVOKE ${leaked} FROM app_user`,
                    `member of "${leaked}"`,
                ],
                [
                    'a member, two levels down through an ordinary role, of pg_read_server_files',
                    `GRANT ${middle} TO app_user`,
                    `REVOKE ${middle} FROM app_user`,
                    'member of "pg_read_server_files"',
                ],
                [
                    'a member of an Amazon RDS role',
                    `GRANT ${provider} TO app_user`,
                    `REVOKE ${provider} FROM app_user`,
                    `member of "${provider}"`,
                ],
            ]
            for (const [label, make, undo, reasons] of cases) {
                await sql.raw(make).execute(admin)
                try {
                    // Named beside the fixture's ordinary role: the refusal grants neither.
                    await expect(grantAppRoles(admin, owner, ['fixture_docket_clerk']), label).rejects.toThrow(
                        `refusing to grant ADMIN on "app_user" (${reasons}): a later owner is handed ADMIN on app_user`,
                    )
                } finally {
                    await sql.raw(undo).execute(admin)
                }
            }
            expect(await membershipsOf(admin, owner)).toEqual([])

            // A member of another app's ordinary role, which this app does not name: what CI's one shared server holds
            // once another suite has migrated there. Not refused, for an app that names no role or one that does.
            await sql.raw(`GRANT ${otherApp} TO app_user`).execute(admin)
            await grantAppRoles(admin, owner, [])
            expect(await membershipsOf(admin, owner)).toEqual([])
            await grantAppRoles(admin, owner, ['fixture_docket_clerk'])
            expect(await membershipsOf(admin, owner)).toEqual(['fixture_docket_clerk:true'])
        } finally {
            await sql.raw(ordinaryAppUser).execute(admin)
            for (const undo of undos) await undo()
            for (const name of [
                ...catalogued,
                leaked,
                ...reached.map(([, name]) => name),
                otherApp,
                provider,
                middle,
                boss,
                owner,
            ]) {
                await sql`DROP ROLE IF EXISTS ${sql.id(name)}`.execute(admin).catch(() => undefined)
            }
            await admin.destroy()
        }
    })

    // The state the review made by hand (Postgres 18): app_user LOGIN CREATEDB with a known password, and a member of
    // pg_execute_server_program. Every statement the pass sends through `admin` is recorded, so a GRANT made before the
    // refusal would be seen even though the teardown drops the owner it went to.
    test('the owner pass refuses such an app_user before it grants the owner anything, and leaves no owner', async () => {
        const { admin, superuser, maintenanceDatabase } = asSuperuser()
        const sent: string[] = []
        const recorder: KyselyPlugin = {
            transformQuery: ({ node }) => {
                if (RawNode.is(node)) sent.push(node.sqlFragments.join('?').trim())
                return node
            },
            transformResult: async ({ result }) => result,
        }
        try {
            const before = await ownersOn(admin)
            await sql`ALTER ROLE app_user LOGIN CREATEDB PASSWORD 'known'`.execute(admin)
            await sql`GRANT pg_execute_server_program TO app_user`.execute(admin)
            const outcome = await runOwnerPass(
                { admin: admin.withPlugin(recorder), superuser, maintenanceDatabase, connect },
                expect,
            ).then(
                () => null,
                (error: unknown) => error,
            )
            expectOnly(
                outcome,
                'refusing to grant ADMIN on "app_user" (CREATEDB, LOGIN, member of "pg_execute_server_program")',
            )
            // The recorder saw the pass create its owner, and no GRANT at all.
            expect(sent.some((statement) => statement.startsWith('CREATE ROLE'))).toBe(true)
            expect(sent.filter((statement) => /^GRANT\b/i.test(statement))).toEqual([])
            expect(await ownersOn(admin)).toEqual(before)
        } finally {
            await sql.raw(ordinaryAppUser).execute(admin)
            await sql`REVOKE pg_execute_server_program FROM app_user`.execute(admin)
            await admin.destroy()
        }
    })

    // ...and after the migrations: the owner's migration holds ADMIN and CREATEROLE on app_user, as on the app's roles.
    test('the owner pass fails when its migrations leave app_user able to log in', async () => {
        try {
            const { outcome, left } = await ownerPassThen(async (ownerDb) => {
                await sql`ALTER ROLE app_user LOGIN PASSWORD 'known'`.execute(ownerDb)
            })
            expectOnly(outcome, 'after the migrations, not an ordinary role: "app_user" (LOGIN).')
            expect(left).toEqual([])
        } finally {
            const { admin } = asSuperuser()
            await sql.raw(ordinaryAppUser).execute(admin)
            await admin.destroy()
        }
    })

    // The second-owner test's own teardown drops two roles: a first that cannot be dropped must not keep the second.
    test("dropping a test's pass roles tries every one, and reports the one it could not drop", async () => {
        const { admin } = asSuperuser()
        const contract = asSuperuser(DATABASE).admin
        const stamp = Date.now()
        const kept = `sssb_kept_role_${stamp}`
        const dropped = `sssb_dropped_role_${stamp}`
        const table = `sssb_kept_by_${stamp}`
        try {
            await sql`CREATE ROLE ${sql.id(kept)} NOLOGIN`.execute(admin)
            await sql`CREATE ROLE ${sql.id(dropped)} NOLOGIN`.execute(admin)
            // A table in a database `dropPassRole`'s DROP OWNED BY does not reach: only a hand can clear it.
            await sql`CREATE TABLE ${sql.id(table)} (i int)`.execute(contract)
            await sql`ALTER TABLE ${sql.id(table)} OWNER TO ${sql.id(kept)}`.execute(contract)
            await expect(dropPassRoles(admin, [kept, dropped])).rejects.toThrow(
                `role "${kept}" cannot be dropped because some objects depend on it`,
            )
            const { rows } = await sql<{ rolname: string }>`
                SELECT rolname FROM pg_roles WHERE rolname IN (${kept}, ${dropped})`.execute(admin)
            expect(rows.map((row) => row.rolname)).toEqual([kept])
        } finally {
            await sql`DROP TABLE IF EXISTS ${sql.id(table)}`.execute(contract)
            await contract.destroy()
            await sql`DROP ROLE IF EXISTS ${sql.id(kept)}`.execute(admin)
            await sql`DROP ROLE IF EXISTS ${sql.id(dropped)}`.execute(admin)
            await admin.destroy()
        }
    })

    // The teardown drops the owner, and an owner it cannot drop fails the pass rather than staying behind quietly: the
    // role may log in, create roles, and holds ADMIN on app_user and the app's roles, on a server that outlives the run.
    // Here the owner owns a table in a database the teardown does not drop, which only a hand can clear.
    test('the owner pass fails when its teardown cannot drop the owner, after every other step ran', async () => {
        const table = `sssb_kept_${Date.now()}`
        const contract = asSuperuser(DATABASE).admin
        let database = ''
        const { owner, outcome } = await ownerPassThen(async (ownerDb, owner) => {
            database = (await sql<{ db: string }>`SELECT current_database() AS db`.execute(ownerDb)).rows[0]!.db
            await sql`CREATE TABLE ${sql.id(table)} (i int)`.execute(contract)
            await sql`ALTER TABLE ${sql.id(table)} OWNER TO ${sql.id(owner)}`.execute(contract)
        })
        const { admin } = asSuperuser()
        try {
            expect(outcome).toBeInstanceOf(Error)
            expect(String(outcome)).toContain(`owner pass: teardown left "${owner}" (`)
            // Every other step ran: the owner's database and its probe role are gone.
            const left = await sql<{ db: number; probe: number }>`
                SELECT (SELECT count(*)::int FROM pg_database WHERE datname = ${database}) AS db,
                       (SELECT count(*)::int FROM pg_roles WHERE rolname = ${`${owner}_probe`}) AS probe`.execute(admin)
            expect(left.rows[0]).toEqual({ db: 0, probe: 0 })
        } finally {
            await sql`DROP TABLE IF EXISTS ${sql.id(table)}`.execute(contract)
            await contract.destroy()
            await dropPassRole(admin, owner)
            await admin.destroy()
        }
    })

    test('the full RLS proof suite passes', async () => {
        await realDb.migrateToLatest()
        await runRlsProofs(realDb.getDb(), expect)
    })

    // safeinsights/sssb#97: the tick's drains list each tenant's due rows under FORCE RLS (inside withTenant, as
    // app_user) with an ORDER BY and a LIMIT, then take the tenants in turn. Proven here on real Postgres, where RLS
    // is not pglite's superuser default.
    test("a bounded drain takes each tenant's due rows in turn under RLS, and leaves the rest due", async () => {
        await realDb.migrateToLatest()
        const admin = realDb.getDb()
        const suffix = randomUUID().slice(0, 8)
        const tenantOrg = async (slug: string) => {
            const tenant = await admin
                .insertInto('tenants')
                .values({ slug: `${slug}-${suffix}`, name: slug })
                .returning('id')
                .executeTakeFirstOrThrow()
            const org = await admin
                .insertInto('organizations')
                .values({ tenant_id: tenant.id, slug: `${slug}-org`, name: slug })
                .returning('id')
                .executeTakeFirstOrThrow()
            return { tenantId: tenant.id, orgId: org.id }
        }
        const schedule = async (who: { tenantId: string; orgId: string }, nextRunAt: Date) =>
            (
                await admin
                    .insertInto('job_schedules')
                    .values({
                        tenant_id: who.tenantId,
                        org_id: who.orgId,
                        kind: 'digest-email',
                        spec: { type: 'weekly', utcDay: 1, atUtcHour: 13, atUtcMinute: 0 },
                        next_run_at: nextRunAt,
                        enabled: true,
                        created_by: 'contract',
                    })
                    .returning('id')
                    .executeTakeFirstOrThrow()
            ).id
        const busy = await tenantOrg('busy')
        const quiet = await tenantOrg('quiet')
        // Long before anything else in this database, so only these rows are due at `now`.
        const busyIds: string[] = []
        for (let i = 0; i < 4; i++) busyIds.push(await schedule(busy, new Date(Date.UTC(2001, 0, 1, 0, i))))
        const quietId = await schedule(quiet, new Date(Date.UTC(2001, 1, 1)))
        const now = new Date(Date.UTC(2001, 5, 1))

        const { runDueSchedules } = await import('../../db/schedules')
        const started: string[] = []
        const jobs = {
            async start(job: { payload: unknown }) {
                started.push((job.payload as { scheduleId: string }).scheduleId)
            },
        }
        const first = await runDueSchedules(realDb, jobs, now, { maxItems: 2, deadline: Number.MAX_SAFE_INTEGER })
        expect(first).toEqual({ spawned: 2, failed: 0, deferred: 2, stoppedBy: 'items' })
        // One turn each, whichever tenant the tick's rotation put first: the busy tenant's oldest row and the quiet one's.
        expect([...started].sort()).toEqual([busyIds[0], quietId].sort())

        const rest = await runDueSchedules(realDb, jobs, now, { maxItems: 100, deadline: Number.MAX_SAFE_INTEGER })
        expect(rest).toEqual({ spawned: 3, failed: 0, deferred: 0, stoppedBy: null })
        expect(started.slice(2)).toEqual(busyIds.slice(1))
    })

    // The server can end a connection at any time: a failover, a reboot, an idle-session timeout, a socket
    // dropped while a Lambda sat frozen between invocations. pg reports that as an 'error' EVENT, and an
    // event with no listener is an uncaught exception, which crashes the process. The adapter must survive
    // it both while the connection sits idle in the pool and while a transaction holds it.
    test('an idle pooled connection the server ends is logged, not a crash, and the pool carries on', async () => {
        const url = new URL(serverUrl)
        url.pathname = `/${DATABASE}`
        url.searchParams.set('application_name', 'sssb_idle_probe')
        const probe = createRealDb(url.toString())
        const admin = connect({
            database: new URL(serverUrl).pathname.slice(1) || 'postgres',
            user: decodeURIComponent(new URL(serverUrl).username),
            password: decodeURIComponent(new URL(serverUrl).password),
        })
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        try {
            // One query, and its connection goes back to the pool idle.
            await sql`select 1`.execute(probe.getDb())
            const ended = await sql<{ n: number }>`
                SELECT count(*)::int AS n FROM (
                    SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                    WHERE application_name = 'sssb_idle_probe' AND state = 'idle'
                ) AS terminated`.execute(admin)
            expect(ended.rows[0]!.n).toBe(1)
            await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('57P01')))
            // The pool drops the dead client and opens a new one for the next query.
            const again = await sql<{ ok: number }>`select 1 as ok`.execute(probe.getDb())
            expect(again.rows).toEqual([{ ok: 1 }])
        } finally {
            warn.mockRestore()
            await probe.getDb().destroy()
            await admin.destroy()
        }
    })

    // ...and while a transaction holds the connection, which is every request: withTenant runs in one, and so
    // does the migrator. pg-pool listens only to IDLE clients, and Kysely adds no listener to the one it
    // checks out, so this case needs its own listener: the transaction fails, and nothing else does.
    test('a connection the server ends inside a transaction fails that transaction, not the process', async () => {
        const url = new URL(serverUrl)
        url.pathname = `/${DATABASE}`
        url.searchParams.set('application_name', 'sssb_busy_probe')
        const probe = createRealDb(url.toString())
        const admin = connect({
            database: new URL(serverUrl).pathname.slice(1) || 'postgres',
            user: decodeURIComponent(new URL(serverUrl).username),
            password: decodeURIComponent(new URL(serverUrl).password),
        })
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        try {
            const outcome = await probe
                .getDb()
                .transaction()
                .execute(async (trx) => {
                    await sql`select 1`.execute(trx)
                    const ended = await sql<{ n: number }>`
                        SELECT count(*)::int AS n FROM (
                            SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                            WHERE application_name = 'sssb_busy_probe' AND state = 'idle in transaction'
                        ) AS terminated`.execute(admin)
                    expect(ended.rows[0]!.n).toBe(1)
                    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('57P01')))
                    await sql`select 1`.execute(trx)
                })
                .then(
                    () => 'committed',
                    (error: unknown) => error,
                )
            expect(outcome).toBeInstanceOf(Error)
            const again = await sql<{ ok: number }>`select 1 as ok`.execute(probe.getDb())
            expect(again.rows).toEqual([{ ok: 1 }])
        } finally {
            warn.mockRestore()
            await probe.getDb().destroy()
            await admin.destroy()
        }
    })
})

// Migration 0015 against a real server, branch by branch: what it grants, what it leaves alone, and how it
// fails. Each case is one throwaway non-superuser role, migrated by calling the migration's own `up`.
describe('migration 0015 on real Postgres', () => {
    interface Membership {
        grantor: string
        admin_option: boolean
        inherit_option: boolean
        set_option: boolean
    }

    async function withRole(
        run: (role: string, roleDb: ReturnType<typeof connect>, admin: ReturnType<typeof connect>) => Promise<void>,
    ) {
        const server = new URL(serverUrl)
        const superuser = { user: decodeURIComponent(server.username), password: decodeURIComponent(server.password) }
        const admin = connect({ ...superuser, database: DATABASE })
        const role = `sssb_0015_${Date.now()}`
        const password = randomUUID()
        await sql`DO $$ BEGIN CREATE ROLE app_user NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`.execute(
            admin,
        )
        await sql`CREATE ROLE ${sql.id(role)} LOGIN CREATEROLE NOSUPERUSER PASSWORD ${sql.lit(password)}`.execute(admin)
        const roleDb = connect({ user: role, password, database: DATABASE })
        try {
            await run(role, roleDb, admin)
        } finally {
            await roleDb.destroy()
            await sql`DROP ROLE IF EXISTS ${sql.id(role)}`.execute(admin).catch(() => undefined)
            await admin.destroy()
        }
    }

    const membershipsOf = async (admin: ReturnType<typeof connect>, role: string) =>
        (
            await sql<Membership>`
                SELECT m.grantor::regrole::text AS grantor, m.admin_option, m.inherit_option, m.set_option
                FROM pg_auth_members m
                WHERE m.roleid = 'app_user'::regrole AND m.member = ${role}::regrole
                ORDER BY 1`.execute(admin)
        ).rows

    test("a creator's ADMIN-only membership gains a SET grant of its own, with INHERIT off", async () => {
        await withRole(async (role, roleDb, admin) => {
            await sql`GRANT app_user TO ${sql.id(role)} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`.execute(admin)
            await grantAppUser(roleDb)
            const rows = await membershipsOf(admin, role)
            expect(rows.find((m) => m.grantor === role)).toEqual({
                grantor: role,
                admin_option: false,
                inherit_option: false,
                set_option: true,
            })
            // ...and it can switch, which is the point.
            await roleDb.transaction().execute(async (trx) => {
                await sql`SET LOCAL ROLE app_user`.execute(trx)
            })
            // Run again: the memberships stay as they are. (The superuser case below is what pins the guard:
            // a re-run here would take the self-grant branch and change nothing even without it.)
            await grantAppUser(roleDb)
            expect(await membershipsOf(admin, role)).toEqual(rows)
        })
    })

    test('a membership the role granted itself keeps the INHERIT an operator chose, and gains SET', async () => {
        await withRole(async (role, roleDb, admin) => {
            await sql`GRANT app_user TO ${sql.id(role)} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`.execute(admin)
            // What `createrole_self_grant = 'inherit'` gives a creator: a self-granted INHERIT membership.
            await sql`GRANT app_user TO ${sql.id(role)} WITH INHERIT TRUE, SET FALSE`.execute(roleDb)
            await grantAppUser(roleDb)
            const own = (await membershipsOf(admin, role)).find((m) => m.grantor === role)
            expect(own?.inherit_option).toBe(true)
            expect(own?.set_option).toBe(true)
        })
    })

    test('a role with no ADMIN on app_user fails, and the error says what to run', async () => {
        await withRole(async (role, roleDb) => {
            await expect(grantAppUser(roleDb)).rejects.toThrow(
                new RegExp(`cannot switch to app_user.*GRANT app_user TO ${role} WITH SET TRUE`),
            )
        })
    })

    test('a superuser is granted nothing: it can already switch', async () => {
        // A FRESH superuser, not `postgres`: an earlier test in this file has already migrated as
        // `postgres`, so whatever 0015 would grant it would already be there to compare against.
        const server = new URL(serverUrl)
        const admin = connect({
            user: decodeURIComponent(server.username),
            password: decodeURIComponent(server.password),
            database: DATABASE,
        })
        const superRole = `sssb_0015_su_${Date.now()}`
        const password = randomUUID()
        try {
            await sql`DO $$ BEGIN CREATE ROLE app_user NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$`.execute(
                admin,
            )
            await sql`CREATE ROLE ${sql.id(superRole)} LOGIN SUPERUSER PASSWORD ${sql.lit(password)}`.execute(admin)
            const superDb = connect({ user: superRole, password, database: DATABASE })
            try {
                await grantAppUser(superDb)
            } finally {
                await superDb.destroy()
            }
            expect(await membershipsOf(admin, superRole)).toEqual([])
        } finally {
            await sql`DROP ROLE IF EXISTS ${sql.id(superRole)}`.execute(admin).catch(() => undefined)
            await admin.destroy()
        }
    })
})
