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

/**
 * The exempt relations (`tenants`, `organizations`, `service_keys`) are SELECT-only unless their entry declares a
 * write, and `organizations` declares INSERT, UPDATE and DELETE (0018_organizations_write). Each case breaks one thing
 * the declaration rests on, on top of the real migrations.
 */
describe('the RLS coverage check, on the exempt relations', () => {
    it('passes the migrations as they are', async () => {
        expect(await coverageFailures(async () => {})).toBe('')
    }, 60_000)

    it('fails a write on an exempt relation that declares none', async () => {
        const failures = await coverageFailures(async (db) => {
            await sql`GRANT UPDATE (name) ON tenants TO app_user`.execute(db)
        })
        expect(failures).toContain('UPDATE (column-level) on the exempt relation public.tenants')
    }, 60_000)

    it('fails TRUNCATE on organizations, which no declaration can cover', async () => {
        const failures = await coverageFailures(async (db) => {
            await sql`GRANT TRUNCATE ON organizations TO app_user`.execute(db)
        })
        expect(failures).toContain('TRUNCATE (table-level) on the exempt relation public.organizations')
    }, 60_000)

    it('fails a declared write that a tenant-blind permissive policy admits', async () => {
        const failures = await coverageFailures(async (db) => {
            await sql`CREATE POLICY rename_anywhere ON organizations FOR UPDATE USING (true)`.execute(db)
        })
        expect(failures).toContain('declares UPDATE, and its permissive policy `rename_anywhere`')
        expect(failures).not.toContain('declares INSERT')
    }, 60_000)

    it('fails every declared write that a tenant-blind ALL policy admits', async () => {
        const failures = await coverageFailures(async (db) => {
            await sql`CREATE POLICY anything_goes ON organizations USING (true)`.execute(db)
        })
        for (const write of ['INSERT', 'UPDATE', 'DELETE']) {
            expect(failures).toContain(`declares ${write}, and its permissive policy \`anything_goes\``)
        }
    }, 60_000)

    it('fails an isolating USING beside a WITH CHECK that lets an UPDATE move a row to another tenant', async () => {
        const failures = await coverageFailures(async (db) => {
            await sql
                .raw(
                    `CREATE POLICY move_anywhere ON organizations FOR UPDATE USING (tenant_id = ${TENANT}) WITH CHECK (true)`,
                )
                .execute(db)
        })
        expect(failures).toContain('`move_anywhere`')
    }, 60_000)

    it('fails declared writes on a relation whose row-level security is off', async () => {
        const failures = await coverageFailures(async (db) => {
            await sql`ALTER TABLE organizations DISABLE ROW LEVEL SECURITY`.execute(db)
        })
        expect(failures).toContain('declares DELETE on public.organizations, which has no ROW LEVEL SECURITY')
    }, 60_000)

    it('fails a declared write that app_user no longer holds', async () => {
        const failures = await coverageFailures(async (db) => {
            await sql`REVOKE DELETE ON organizations FROM app_user`.execute(db)
        })
        expect(failures).toContain('declares DELETE on public.organizations, which app_user does not hold')
    }, 60_000)

    it('fails a declared write that no permissive policy admits', async () => {
        const failures = await coverageFailures(async (db) => {
            await sql`DROP POLICY organizations_tenant_insert ON organizations`.execute(db)
        })
        expect(failures).toContain('no permissive policy admits INSERT')
    }, 60_000)
})
