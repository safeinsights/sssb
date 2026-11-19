import { sql } from 'kysely'
import { encodeKeysetCursor, parseKeysetCursor } from '@sssb/kit/core/keyset'
import { parseDbKeysetCursor } from '@sssb/kit/db/keyset'
import type { RlsProofSuite } from '@sssb/kit/db/rls-proofs'
import { runWithTenant } from '@sssb/kit/db/with-tenant'
import { listItems } from '@/domain/db/items'

/**
 * The APP's tenant-isolation proofs (the seam side of @sssb/kit/db/rls-proofs.ts, ADR-0004 + ADR-0012) —
 * one section per app table, asserting exactly what the framework half asserts for its own: read
 * isolation both directions under UNFILTERED selects, WITH CHECK on cross-tenant writes, and the
 * per-table privilege grants.
 *
 * @sssb/kit/db/rls-proof-runner.ts composes this with the framework half and runs the union, so these
 * assertions execute wherever that runner does. An adopter with no tenant tables leaves the body empty
 * (ADR-0012, "unused capability = empty registration"). Kept in lockstep with ./migrations.
 */
export const appRlsProofs: RlsProofSuite = async ({
    db,
    appDb,
    dbPort,
    expect,
    alphaTenantId,
    demoTenantId,
    alphaOrgId,
    demoOrgId,
}) => {
    // ---- items: tenant-only RLS (1001), single-org app scoping, SELECT/INSERT/UPDATE (no DELETE) ----

    await db
        .insertInto('items')
        .values([
            { tenant_id: alphaTenantId, org_id: alphaOrgId, title: 'first item', created_by_user_id: 'proof-user' },
            { tenant_id: alphaTenantId, org_id: alphaOrgId, title: 'second item', created_by_user_id: 'proof-user' },
            {
                tenant_id: demoTenantId,
                org_id: demoOrgId,
                title: 'other tenant item',
                created_by_user_id: 'proof-user',
            },
        ])
        .execute()

    // read isolation, both directions, via UNFILTERED selects under RLS
    const ours = await runWithTenant(appDb, alphaTenantId, (trx) => trx.selectFrom('items').selectAll().execute())
    expect(ours.filter((r) => r.tenant_id === demoTenantId).length).toBe(0)
    expect(ours.filter((r) => r.tenant_id === alphaTenantId).length).toBe(2)
    const theirs = await runWithTenant(appDb, demoTenantId, (trx) => trx.selectFrom('items').selectAll().execute())
    expect(theirs.filter((r) => r.tenant_id === alphaTenantId).length).toBe(0)
    expect(theirs.filter((r) => r.tenant_id === demoTenantId).length).toBe(1)

    // write isolation: an INSERT carrying the OTHER tenant's id is rejected by WITH CHECK, even though
    // the org id is a real org — the tenant, not the org, is the RLS boundary.
    let writeRejected = false
    try {
        await runWithTenant(appDb, alphaTenantId, (trx) =>
            trx
                .insertInto('items')
                .values({
                    tenant_id: demoTenantId,
                    org_id: demoOrgId,
                    title: 'smuggled',
                    created_by_user_id: 'proof-user',
                })
                .execute(),
        )
    } catch (error) {
        writeRejected = /row-level security/.test(String(error))
    }
    expect(writeRejected).toBe(true)

    // DELETE is denied at the PRIVILEGE layer — the 1001 grant is SELECT/INSERT/UPDATE only, so an
    // item can never be erased even by a correctly-scoped caller.
    let deleteRejected = false
    try {
        await appDb.transaction().execute(async (trx) => {
            await sql`SET LOCAL ROLE app_user`.execute(trx)
            await sql`SELECT set_config('app.current_tenant', ${alphaTenantId}, true)`.execute(trx)
            await sql`DELETE FROM items`.execute(trx)
        })
    } catch (error) {
        deleteRejected = /permission denied/.test(String(error))
    }
    expect(deleteRejected).toBe(true)

    // ---- the PAGED items list: neither boundary moves when a cursor is involved ----
    //
    // The tenant boundary is RLS's, and the framework half proves a cursor cannot cross it. This half proves
    // the one the app adds on top, the team (an app-level WHERE, not a policy), because that is the one a
    // hand-rolled pager loses: page one is built from the session, page two from the cursor, and the org
    // filter is on the first query only. There is no such second query here, and these assertions say so.
    //
    // Driven through the PRODUCTION function, `listItems`, the same call GET /api/items makes: a proof of a
    // copy of the read path proves nothing about the read path.

    const stamp = Date.now()
    const [pageOrgP] = await db
        .insertInto('organizations')
        .values({ tenant_id: alphaTenantId, slug: `page-p-${stamp}`, name: 'Page Org P' })
        .returning('id')
        .execute()
    const [pageOrgQ] = await db
        .insertInto('organizations')
        .values({ tenant_id: alphaTenantId, slug: `page-q-${stamp}`, name: 'Page Org Q' })
        .returning('id')
        .execute()

    // Six items for team P, three for team Q, three for the OTHER TENANT. Every row in a batch shares ONE
    // created_at, written at MICROSECOND precision: the two properties that break a hand-rolled pager (no
    // defined position inside a batch; a cursor truncated to a JS millisecond that excludes the batch it
    // points into).
    const batch = (tenantId: string, orgId: string, label: string, count: number, at: string) =>
        Array.from({ length: count }, (_, index) => ({
            tenant_id: tenantId,
            org_id: orgId,
            title: `${label}-${stamp}-${index}`,
            created_by_user_id: 'proof-user',
            created_at: at,
        }))
    await db
        .insertInto('items')
        .values([
            ...batch(alphaTenantId, pageOrgP!.id, 'KP', 6, '2020-03-04T05:06:07.123456Z'),
            ...batch(alphaTenantId, pageOrgQ!.id, 'KQ', 3, '2020-03-04T05:06:08.654321Z'),
            ...batch(demoTenantId, demoOrgId, 'KD', 3, '2020-03-04T05:06:09.987654Z'),
        ])
        .execute()

    /** Walk a team's list to the end through the real read path, and report everything it showed. */
    const walk = async (tenantId: string, orgId: string, limit: number) => {
        const seen: string[] = []
        let cursor: string | null = null
        for (let guard = 0; guard < 50; guard++) {
            const parsed = parseDbKeysetCursor(cursor)
            expect(parsed.kind === 'invalid').toBe(false)
            const page = await listItems(dbPort, tenantId, orgId, { after: parsed.position ?? null, limit })
            seen.push(...page.items.map((item) => item.title))
            if (page.nextCursor === null) return seen
            cursor = page.nextCursor
        }
        throw new Error('keyset proof: the items walk did not terminate')
    }

    // (a) a full walk at a page size that cuts through the batch shows team P's six, once each, and no
    // sight of team Q's or of the other tenant's.
    const walkedP = await walk(alphaTenantId, pageOrgP!.id, 2)
    expect(walkedP.length).toBe(6)
    expect(new Set(walkedP).size).toBe(6)
    expect(walkedP.every((title) => title.startsWith(`KP-${stamp}-`))).toBe(true)

    // (b) THE ATTACK on the team boundary: a cursor minted while paging team Q's list, handed to team P's.
    // The two teams share a tenant, so RLS is not what stops this; the org filter is, and it is re-applied
    // because the pager rebuilds the whole query on every page rather than resuming one.
    const teamQPage = await listItems(dbPort, alphaTenantId, pageOrgQ!.id, { after: null, limit: 1 })
    expect(teamQPage.nextCursor !== null).toBe(true)
    const crossTeam = await listItems(dbPort, alphaTenantId, pageOrgP!.id, {
        after: parseDbKeysetCursor(teamQPage.nextCursor).position ?? null,
        limit: 50,
    })
    expect(crossTeam.items.length).toBe(6)
    expect(crossTeam.items.every((item) => item.title.startsWith(`KP-${stamp}-`))).toBe(true)

    // (c) the same across TENANTS: a cursor minted in the other tenant, replayed against alpha's list. The
    // tenant comes from withTenant, which the pager opens from the caller's session, never from the cursor.
    const demoList = await listItems(dbPort, demoTenantId, demoOrgId, { after: null, limit: 1 })
    expect(demoList.nextCursor !== null).toBe(true)
    const crossTenant = await listItems(dbPort, alphaTenantId, pageOrgP!.id, {
        after: parseDbKeysetCursor(demoList.nextCursor).position ?? null,
        limit: 50,
    })
    expect(crossTenant.items.length).toBe(6)
    expect(crossTenant.items.every((item) => item.title.startsWith(`KP-${stamp}-`))).toBe(true)

    // (d) a cursor crafted to name a REAL item of the other team, at a timestamp that opens the predicate
    // as wide as it goes. Still exactly team P's six rows.
    const teamQFirst = teamQPage.items[0]
    expect(teamQFirst !== undefined).toBe(true)
    const crafted = await listItems(dbPort, alphaTenantId, pageOrgP!.id, {
        after:
            parseKeysetCursor(encodeKeysetCursor({ at: '2999-01-01T00:00:00.000000Z', id: teamQFirst!.id })).position ??
            null,
        limit: 50,
    })
    expect(crafted.items.length).toBe(6)
    expect(crafted.items.every((item) => item.title.startsWith(`KP-${stamp}-`))).toBe(true)
}
