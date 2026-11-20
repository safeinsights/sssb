import {
    type CompiledQuery,
    DummyDriver,
    Kysely,
    PostgresAdapter,
    PostgresIntrospector,
    PostgresQueryCompiler,
    sql,
    type SqlBool,
} from 'kysely'
import { describe, expect, it } from 'vitest'
import { dbPortFor } from '../adapters/real/db-port'
import { family } from './family'
import { familySuite } from './family-suite'
import { jsonb } from './jsonb'
import type { DB } from './schema'
import { runWithTenant } from './with-tenant'

/**
 * The Postgres family is a refactor, not a change: every query that now goes through one of its helpers must send
 * the SQL it sent when the call site wrote it inline. Each case below builds the query both ways, the inline form as
 * the call site had it before (./jobs.ts, ./schedules.ts, ./webhooks.ts, ./audit.ts, ./notifications.ts, ./keyset.ts)
 * and the family's, and compares what Kysely compiles: the text and the parameters. Compiled only, never run.
 */
const db = new Kysely<DB>({
    dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (kysely) => new PostgresIntrospector(kysely),
        createQueryCompiler: () => new PostgresQueryCompiler(),
    },
})

const sent = (query: { compile(): CompiledQuery }) => {
    const { sql: text, parameters } = query.compile()
    return { text, parameters }
}

const ID = '8f2c0d2e-3b1a-4f5e-9c7d-1a2b3c4d5e6f'

describe('the Postgres family sends the SQL its call sites wrote inline', () => {
    it('lockRow is FOR UPDATE, on one table (jobs, schedules)', () => {
        const base = () => db.selectFrom('jobs').select(['status', 'org_id', 'kind']).where('id', '=', ID)
        expect(sent(base().$call(family.lockRow))).toEqual(sent(base().forUpdate()))
        expect(sent(base().$call(family.lockRow)).text).toBe(
            'select "status", "org_id", "kind" from "jobs" where "id" = $1 for update',
        )
    })

    it('lockRow is FOR UPDATE, on aliased joined tables (webhook deliveries)', () => {
        const base = () =>
            db
                .selectFrom('webhook_deliveries as d')
                .innerJoin('webhook_endpoints as e', 'e.id', 'd.endpoint_id')
                .select(['d.status as status', 'e.url as url'])
                .where('d.id', '=', ID)
        expect(sent(base().$call(family.lockRow))).toEqual(sent(base().forUpdate()))
    })

    it("currentTime is the database's now()", () => {
        const set = (updatedAt: ReturnType<typeof sql<string>>) =>
            db.updateTable('jobs').set({ status: 'running', updated_at: updatedAt }).where('id', '=', ID)
        expect(sent(set(family.currentTime()))).toEqual(sent(set(sql<string>`now()`)))
        expect(sent(set(family.currentTime())).text).toBe(
            'update "jobs" set "status" = $1, "updated_at" = now() where "id" = $2',
        )
    })

    it('json is the jsonb encoding, for an array and for an object', () => {
        const kinds = ['job.status_changed']
        const endpoint = (eventKinds: ReturnType<typeof jsonb<string[]>>) =>
            db.insertInto('webhook_endpoints').values({
                tenant_id: ID,
                org_id: ID,
                url: 'https://hooks.example.test',
                secret: 's',
                event_kinds: eventKinds,
                created_by: 'user-ada',
            })
        expect(sent(endpoint(family.json(kinds)))).toEqual(sent(endpoint(jsonb(kinds))))
        expect(sent(endpoint(family.json(kinds))).text).toContain('$5::jsonb')

        const detail = { refusal: 'revoked', steps: ['a', 'b'] }
        expect(sent(db.selectNoFrom(family.json(detail).as('v')))).toEqual(sent(db.selectNoFrom(jsonb(detail).as('v'))))
        // `family.json` IS `jsonb` today, so the comparisons above hold by identity; these pin what both send.
        expect(sent(db.selectNoFrom(family.json(detail).as('v')))).toEqual({
            text: 'select $1::jsonb as "v"',
            parameters: [JSON.stringify(detail)],
        })
        expect(sent(endpoint(family.json(kinds))).parameters[4]).toBe(JSON.stringify(kinds))
    })

    describe('keysetSlice is the keyset ordering, window and cursor rendering keyset.ts wrote', () => {
        // ./keyset.ts before the family, verbatim but for the names.
        const inline = (orderColumn: string, after: { at: string; id: string } | null, take: number) => {
            const orderRef = sql.ref(orderColumn)
            const scoped = db.selectFrom('jobs').select(['id', 'kind']).where('org_id', '=', ID)
            const windowed = after
                ? scoped.where(sql<SqlBool>`(${orderRef}, id) < (${after.at}::timestamptz, ${after.id}::uuid)`)
                : scoped
            return windowed
                .select(
                    sql<string>`to_char(${orderRef} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
                        'keyset_at',
                    ),
                )
                .orderBy(orderRef, 'desc')
                .orderBy(sql`id`, 'desc')
                .limit(take)
        }
        const viaFamily = (orderColumn: string, after: { at: string; id: string } | null, take: number) =>
            family.keysetSlice(db.selectFrom('jobs').select(['id', 'kind']).where('org_id', '=', ID), {
                orderColumn,
                after,
                take,
            })

        const cases: [string, string, { at: string; id: string } | null][] = [
            ['the first page, by created_at', 'created_at', null],
            ['a later page, by created_at', 'created_at', { at: '2026-11-19T10:00:00.123456Z', id: ID }],
            ['a later page, by another column', 'updated_at', { at: '2026-11-19T10:00:00.000000Z', id: ID }],
        ]
        it.each(cases)('%s', (_name, column, after) => {
            expect(sent(viaFamily(column, after, 26))).toEqual(sent(inline(column, after, 26)))
        })
    })
})

describe('the Postgres family is the one every transport runs', () => {
    it('is the family in use, isolating by row-level security', () => {
        expect(family.name).toBe('postgres')
        expect(family.isolation).toBe('rls')
    })

    it("scopes a tenant with the framework's runWithTenant", () => {
        expect(family.runWithTenant).toBe(runWithTenant)
    })

    it('every Postgres transport declares the family isolation', async () => {
        const { fakeDb } = await import('../adapters/fake/db')
        expect(fakeDb.isolation).toBe(family.isolation)
        // node-postgres and the Data API share one port shape (../adapters/real/db-port.ts)
        expect(dbPortFor(db).isolation).toBe(family.isolation)
    })

    it("loads the framework's migrations, the migrator and the proof runner", async () => {
        const { frameworkMigrations, migrations } = await familySuite.migrations()
        expect(Object.keys(frameworkMigrations)).toContain('0001_tenants')
        expect(Object.keys(migrations)).toEqual(expect.arrayContaining(Object.keys(frameworkMigrations)))
        expect(await familySuite.migrator()).toBe(await import('./migrate'))
        expect((await familySuite.proofs()).runRlsProofs).toBe((await import('./rls-proof-runner')).runRlsProofs)
    })
})
