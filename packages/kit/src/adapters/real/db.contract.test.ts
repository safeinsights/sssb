import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, onTestFinished, test, vi } from 'vitest'
import { startContractServer, type ContractServer } from './contract-postgres'
import { randomUUID } from 'node:crypto'
import { migrateToLatest } from '../../db/migrate'
import { up as grantAppUser } from '../../db/migrations/0015_app_user_grant'
import { runWithTenant } from '../../db/with-tenant'
import { appRoles } from '../../db/app-roles'
import { dropPassRole, grantAppRoles, runOwnerPass } from '../../db/owner-pass'
import { runRlsProofs } from '../../db/rls-proof-runner'
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

/** A connection for a login on this server, through the REAL adapter (its pool, its `date` parser). */
function connect(login: { database: string; user: string; password: string }) {
    const url = new URL(serverUrl)
    url.username = encodeURIComponent(login.user)
    url.password = encodeURIComponent(login.password)
    url.pathname = `/${login.database}`
    return createRealDb(url.toString()).getDb()
}

describe('SSSB fixture seam on real Postgres, through the real adapter (contract)', () => {
    // FIRST, deliberately (vitest runs a file's tests in order): on a fresh server, which a local run's
    // embedded one always is and CI's service is when this file runs before the app's, nothing has created
    // `app_user` yet, so the owner creates it itself. The next test runs the pass again on the same server,
    // which takes the branch a reused server takes (owner-pass.ts).
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
        // owner pass's teardown, ../../db/owner-pass.ts). `second` first: the creator granted it app_user.
        onTestFinished(async () => {
            try {
                await dropPassRole(admin, second)
                await dropPassRole(admin, creator)
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
            expect(failure).toMatch(new RegExp(`keel: role ${second} cannot switch to app_user`))
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
    // ADMIN lets its holder grant itself SET on the role, so the role's memberships are its power too, at any depth.
    test("the owner pass refuses ADMIN on a named role that is not ordinary: an attribute, or a membership beyond app_user and the app's roles", async () => {
        const { admin } = asSuperuser()
        const stamp = Date.now()
        const owner = `sssb_refused_owner_${stamp}`
        const created: string[] = [owner]
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
            for (const [label, name, reasons] of cases) {
                // Named beside the fixture's ordinary role: the refusal grants neither.
                await expect(grantAppRoles(admin, owner, ['fixture_docket_clerk', name]), label).rejects.toThrow(
                    `refusing to grant ADMIN on "${name}" (${reasons}), which appRoles names`,
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
            for (const name of created.reverse()) {
                await sql`DROP ROLE IF EXISTS ${sql.id(name)}`.execute(admin).catch(() => undefined)
            }
            await admin.destroy()
        }
    })

    /**
     * The owner pass, with `after` run once the owner's migrations have: on the owner's own connection, with the owner's
     * name and a superuser connection. Resolves to what the pass threw (null when it passed), and the owner's name.
     */
    async function ownerPassThen(
        after: (ownerDb: ReturnType<typeof connect>, owner: string, admin: ReturnType<typeof connect>) => Promise<void>,
    ) {
        const { admin, superuser, maintenanceDatabase } = asSuperuser()
        let owner = ''
        try {
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
            return { owner, outcome }
        } finally {
            await admin.destroy()
        }
    }

    // The migration itself runs as the owner, with ADMIN and CREATEROLE on the app's role: it can make that role LOGIN
    // with a password it chose, or CREATEDB. Once the migrations ran, the pass checks every named role is still ordinary,
    // and fails naming the role and what it gained.
    test('the owner pass fails when its migrations leave a named role able to log in, or to create databases', async () => {
        try {
            const { outcome } = await ownerPassThen(async (ownerDb) => {
                await sql`ALTER ROLE fixture_docket_clerk LOGIN CREATEDB PASSWORD 'known'`.execute(ownerDb)
            })
            expect(String(outcome)).toMatch(
                /after the migrations, appRoles names "fixture_docket_clerk" \(CREATEDB, LOGIN\)/,
            )
        } finally {
            const { admin } = asSuperuser()
            await sql`ALTER ROLE fixture_docket_clerk NOLOGIN NOCREATEDB PASSWORD NULL`.execute(admin)
            await admin.destroy()
        }
    })

    // Whichever branch each named role took (created by the owner's migration, or granted before it), the owner holds
    // ADMIN on it after the migrations: the pass checks that, so a grant that stops reaching the owner is seen.
    test('the owner pass fails when the owner does not hold ADMIN on a named role after its migrations', async () => {
        const { outcome } = await ownerPassThen(async (_ownerDb, owner, admin) => {
            // CASCADE: the owner's migration granted the clerk to app_user on the strength of that ADMIN.
            await sql`REVOKE fixture_docket_clerk FROM ${sql.id(owner)} CASCADE`.execute(admin)
        })
        expect(String(outcome)).toMatch(/ADMIN on fixture_docket_clerk: false/)
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
