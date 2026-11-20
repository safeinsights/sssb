import { Kysely, sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { openPglite, PGliteDialect } from '../adapters/fake/pglite-dialect'
import { familySuite } from './family-suite'
import { proveRlsCoverage } from './rls-coverage'
import type { DB } from './schema'

const TENANT = `NULLIF(current_setting('app.current_tenant', true), '')::uuid`

/** The coverage check's failures against a migrated pglite with `setup` applied on top, '' when it passes. */
async function coverageFailures(setup: (db: Kysely<DB>) => Promise<void>): Promise<string> {
    const db = new Kysely<DB>({ dialect: new PGliteDialect(openPglite()) })
    try {
        const { migrateToLatest } = await familySuite.migrator()
        await migrateToLatest(db)
        await setup(db)
        let failures = ''
        await proveRlsCoverage(db, (actual) => ({
            toBe: () => {
                failures = String(actual)
            },
        }))
        return failures
    } finally {
        await db.destroy()
    }
}

async function isolatedTable(db: Kysely<DB>): Promise<void> {
    await sql`CREATE TABLE probe_notes (id uuid PRIMARY KEY, tenant_id uuid NOT NULL)`.execute(db)
    await sql`GRANT SELECT, INSERT ON probe_notes TO app_user`.execute(db)
    await sql`ALTER TABLE probe_notes ENABLE ROW LEVEL SECURITY`.execute(db)
    await sql`ALTER TABLE probe_notes FORCE ROW LEVEL SECURITY`.execute(db)
    await sql.raw(`CREATE POLICY tenant_isolation ON probe_notes USING (tenant_id = ${TENANT})`).execute(db)
}

describe('the RLS coverage check, one policy at a time', () => {
    it('passes a table with one isolating policy', async () => {
        expect(await coverageFailures(isolatedTable)).toBe('')
    }, 60_000)

    it('fails a second permissive policy that ignores the tenant, beside an isolating one', async () => {
        const failures = await coverageFailures(async (db) => {
            await isolatedTable(db)
            // Permissive policies are OR-ed: this one opens every row to every tenant.
            await sql`CREATE POLICY read_all ON probe_notes FOR SELECT USING (true)`.execute(db)
        })
        expect(failures).toContain('public.probe_notes')
        expect(failures).toContain('read_all')
    }, 60_000)

    it('fails an isolating USING beside a tenant-blind WITH CHECK in the same policy', async () => {
        const failures = await coverageFailures(async (db) => {
            await sql`CREATE TABLE probe_notes (id uuid PRIMARY KEY, tenant_id uuid NOT NULL)`.execute(db)
            await sql`GRANT SELECT, INSERT ON probe_notes TO app_user`.execute(db)
            await sql`ALTER TABLE probe_notes ENABLE ROW LEVEL SECURITY`.execute(db)
            await sql`ALTER TABLE probe_notes FORCE ROW LEVEL SECURITY`.execute(db)
            await sql
                .raw(`CREATE POLICY write_anywhere ON probe_notes USING (tenant_id = ${TENANT}) WITH CHECK (true)`)
                .execute(db)
        })
        expect(failures).toContain('write_anywhere')
    }, 60_000)

    it('passes an INSERT-only policy whose WITH CHECK isolates (it has no USING)', async () => {
        const failures = await coverageFailures(async (db) => {
            await isolatedTable(db)
            await sql
                .raw(`CREATE POLICY add_own ON probe_notes FOR INSERT WITH CHECK (tenant_id = ${TENANT})`)
                .execute(db)
        })
        expect(failures).toBe('')
    }, 60_000)

    it('passes a tenant-blind RESTRICTIVE policy beside an isolating one (it can only narrow)', async () => {
        const failures = await coverageFailures(async (db) => {
            await isolatedTable(db)
            await sql`CREATE POLICY no_nulls ON probe_notes AS RESTRICTIVE USING (id IS NOT NULL)`.execute(db)
        })
        expect(failures).toBe('')
    }, 60_000)
})
