import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { CONTRACT_SSL, startContractServer, type ContractServer } from '../adapters/real/contract-postgres'
import { createRealDb } from '../adapters/real/db'
import type { DbPort } from '../ports/db'

/**
 * The due hints' read and settle at a size, on real Postgres with real statistics (safeinsights/sssb#202). A planner
 * that knows one tenant holds every past-due event may run a per-tenant check of the events table once for every
 * tenant; this pins that the read stays one pass over the events however Postgres plans it, that a read that cannot
 * finish in its window degrades to listing every tenant, and that a tenant's pile is cleared in proportion to its
 * size, a bounded statement at a time, inside the drain's window. In a database of its own, so its thousands of
 * tenants slow no other contract test.
 */

const DATABASE = 'sssb_due_hints'
const TENANTS = 1_500
const PILE = 100_000

let server: ContractServer
let realDb: DbPort
let piled: { id: string; orgId: string }

beforeAll(async () => {
    server = await startContractServer('sssb-due-hints')
    await server.recreateDatabase(DATABASE)
    const url = new URL(server.url)
    url.pathname = `/${DATABASE}`
    realDb = createRealDb(url.toString(), CONTRACT_SSL)
    await realDb.migrateToLatest()
    const admin = realDb.getDb()
    await sql`
        INSERT INTO tenants (slug, name) SELECT 'tn-' || g, 'Tenant ' || g FROM generate_series(1, ${TENANTS}) g
    `.execute(admin)
    const first = await admin.selectFrom('tenants').select('id').orderBy('slug').executeTakeFirstOrThrow()
    const org = await admin
        .insertInto('organizations')
        .values({ tenant_id: first.id, slug: 'o', name: 'o' })
        .returning('id')
        .executeTakeFirstOrThrow()
    piled = { id: first.id, orgId: org.id }
}, 300_000)

afterAll(async () => {
    await realDb?.getDb().destroy()
    await server?.stop()
})

/** Every tenant hinted hours off for `drain`, and one tenant's pile of events already due, then ANALYZE. */
async function pileUp(drain: 'retries' | 'schedules', now: Date) {
    const admin = realDb.getDb()
    await sql`DELETE FROM due_hint_events`.execute(admin)
    await sql`
        INSERT INTO due_hints (tenant_id, drain, list_after, version)
        SELECT id, ${drain}, ${new Date(now.getTime() + 6 * 3_600_000)}::timestamptz, 1 FROM tenants
        ON CONFLICT (tenant_id, drain) DO UPDATE SET list_after = excluded.list_after
    `.execute(admin)
    await sql`
        INSERT INTO due_hint_events (tenant_id, drain, due)
        SELECT ${piled.id}::uuid, ${drain}, ${new Date(now.getTime() - 3_600_000)}::timestamptz
        FROM generate_series(1, ${PILE})
    `.execute(admin)
    for (const table of ['tenants', 'due_hints', 'due_hint_events'])
        await sql`ANALYZE ${sql.table(table)}`.execute(admin)
}

const eventsOf = async (tenantId: string) =>
    Number(
        (
            await sql<{
                n: string
            }>`SELECT count(*)::text AS n FROM due_hint_events WHERE tenant_id = ${tenantId}::uuid`.execute(
                realDb.getDb(),
            )
        ).rows[0]!.n,
    )

describe('the due hints at a size, on real Postgres with its statistics', () => {
    test("one tenant's pile of past-due events: the read stays quick, and lists that tenant", async () => {
        const now = new Date()
        await pileUp('retries', now)
        const { tenantsToList } = await import('./due-hints')
        const started = Date.now()
        const read = await tenantsToList(realDb, 'retries', now)
        const elapsed = Date.now() - started
        expect(read.tenants.map((t) => t.id)).toEqual([piled.id])
        expect(read.tenants[0]?.unhinted).toBeUndefined()
        expect(elapsed).toBeLessThan(1_000)
        // However Postgres plans it, the events are read once: no per-tenant subplan, one scan node over them.
        const { dueHintsReadQuery } = await import('./family')
        const cap = new Date(now.getTime() + 24 * 3_600_000)
        const plan = (
            await sql<{ 'QUERY PLAN': string }>`EXPLAIN ${dueHintsReadQuery('retries', now, cap)}`.execute(
                realDb.getDb(),
            )
        ).rows.map((r) => r['QUERY PLAN'])
        expect(plan.filter((line) => /SubPlan/.test(line))).toEqual([])
        expect(plan.filter((line) => /Scan.* on due_hint_events/.test(line))).toHaveLength(1)
    }, 300_000)

    test('a read that cannot finish inside its window gives up, and the drain lists every tenant', async () => {
        const now = new Date()
        const { tenantsToList } = await import('./due-hints')
        // A lock that blocks every read of the events, held by a transaction that stays open for the whole read.
        let release!: () => void
        const gate = new Promise<void>((resolve) => (release = resolve))
        let locked!: () => void
        const held = new Promise<void>((resolve) => (locked = resolve))
        const holder = realDb
            .getDb()
            .transaction()
            .execute(async (trx) => {
                await sql`LOCK TABLE due_hint_events IN ACCESS EXCLUSIVE MODE`.execute(trx)
                locked()
                await gate
            })
        await held
        // Released after 3 s whatever happens, so a read that waits on it fails the bound rather than hanging.
        const timer = setTimeout(() => release(), 3_000)
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const started = Date.now()
        try {
            const read = await tenantsToList(realDb, 'retries', now, { deadline: Date.now() + 400 })
            expect(read.tenants).toHaveLength(TENANTS)
            expect(read.tenants.every((t) => t.unhinted === true)).toBe(true)
            expect(Date.now() - started).toBeLessThan(1_500)
        } finally {
            clearTimeout(timer)
            warn.mockRestore()
            release()
            await holder
        }
    }, 300_000)

    test('a drain clears a pile in proportion to its size, a bounded statement at a time, inside its window', async () => {
        const now = new Date()
        await pileUp('retries', now)
        const { runDueRetries } = await import('./jobs')
        const tickStart = Date.now()
        const result = await runDueRetries(realDb, { start: async () => undefined }, now, {
            maxItems: 100,
            deadline: tickStart + 2_000,
            dueHints: true,
        })
        const elapsed = Date.now() - tickStart
        expect(result.stoppedBy).toBeNull()
        expect(await eventsOf(piled.id)).toBe(0)
        expect(elapsed).toBeLessThan(2_500)
    }, 300_000)
})
