import { sql } from 'kysely'
import type { DbPort } from '../ports/db'

/**
 * Which tenants a drain of the scheduled tick lists (safeinsights/sssb#202). Each drain lists a tenant's due rows
 * inside `withTenant`, a transaction of its own, so listing every tenant costs every tenant those round trips on every
 * tick, whether or not anything is due: four Data API calls a tenant a drain. `due_hints` (0022_due_hints) holds, per
 * tenant and drain, the earliest instant that tenant may have work due, and a drain that uses it lists only the
 * tenants whose hint has come (or that have none).
 *
 * The hint is never later than the truth: database triggers lower it on every write that can make work due (the
 * migration lists them; one that must create the row writes "unknown", the epoch), and the drain raises it only by
 * compare-and-set, after listing a tenant that had nothing
 * due, to that tenant's next due time; a write that lowered it meanwhile bumped its version, so the raise does not
 * land. A hint more than `MAX_SKIP_MS` away is read as come, so no tenant goes unlisted for longer than that, and a
 * simulated world whose clock was moved back cannot strand one.
 *
 * Read and written through the raw handle, as the tick already reads `tenants`: the table belongs to the migration
 * owner, the role the server connects as, and `app_user` has no grant on it. A hint that cannot be read (a server
 * connecting as some other role) is no reason to skip anything: the drain lists every tenant, as before.
 */

export type DueDrain = 'schedules' | 'retries' | 'deliveries'

/** The longest a hint lets a drain leave a tenant unlisted: a day, so every tenant is listed at least once a day. */
export const MAX_SKIP_MS = 24 * 60 * 60_000

/** How long a raise waits for a hint row another transaction holds before it gives up (and the tenant is relisted). */
const RAISE_LOCK_TIMEOUT_MS = 100

/** A tenant a drain lists, with the version of its hint as read (null when it has none). */
export interface HintedTenant {
    id: string
    hintVersion: string | null
    /** Set when the hints could not be read: the tenant is listed, and its hint is left as it is. */
    unhinted?: boolean
}

/**
 * The tenants `drain` lists at `now`: those with no hint, a hint that has come, or one further off than
 * `MAX_SKIP_MS`. One query. Every tenant, with no versions (so nothing is raised later), when the hints cannot be read.
 */
export async function tenantsToList(db: DbPort, drain: DueDrain, now: Date): Promise<HintedTenant[]> {
    const raw = db.getDb()
    try {
        const rows = await raw
            .selectFrom('tenants as t')
            .leftJoin('due_hints as h', (join) => join.onRef('h.tenant_id', '=', 't.id').on('h.drain', '=', drain))
            .select(['t.id as id', 'h.version as version'])
            .where((eb) =>
                eb.or([
                    eb('h.tenant_id', 'is', null),
                    eb('h.list_after', '<=', now),
                    eb('h.list_after', '>', new Date(now.getTime() + MAX_SKIP_MS)),
                ]),
            )
            .execute()
        return rows.map((r) => ({ id: r.id, hintVersion: r.version === null ? null : String(r.version) }))
    } catch (error) {
        console.warn(
            `SSSB tick: the ${drain} drain could not read its due hints, so it lists every tenant: ${messageOf(error)}`,
        )
        const all = await raw.selectFrom('tenants').select('id').execute()
        return all.map((t) => ({ id: t.id, hintVersion: null, unhinted: true }))
    }
}

/**
 * After listing `tenant` for `drain` and finding nothing due, moves its hint to `nextDue` (the tenant's next due
 * time, or none), at most `MAX_SKIP_MS` away: a compare-and-set on the version read before listing, so a write that
 * lowered the hint since is kept. Never throws: a hint not raised only means the tenant is listed again.
 */
export async function raiseHint(
    db: DbPort,
    tenant: HintedTenant,
    drain: DueDrain,
    now: Date,
    nextDue: Date | null,
): Promise<void> {
    if (tenant.unhinted) return
    const cap = new Date(now.getTime() + MAX_SKIP_MS)
    const listAfter = nextDue !== null && nextDue.getTime() < cap.getTime() ? nextDue : cap
    try {
        // Under a short lock timeout: the row a tenant's own open transaction has just lowered is locked until it
        // commits, and a drain must not wait on it (a raise that does not land only means the tenant is listed again).
        await db
            .getDb()
            .transaction()
            .execute(async (trx) => {
                await sql`SET LOCAL lock_timeout = '${sql.raw(String(RAISE_LOCK_TIMEOUT_MS))}ms'`.execute(trx)
                if (tenant.hintVersion === null) {
                    await trx
                        .insertInto('due_hints')
                        .values({ tenant_id: tenant.id, drain, list_after: listAfter })
                        .onConflict((oc) => oc.columns(['tenant_id', 'drain']).doNothing())
                        .execute()
                } else {
                    await trx
                        .updateTable('due_hints')
                        .set({ list_after: listAfter })
                        .where('tenant_id', '=', tenant.id)
                        .where('drain', '=', drain)
                        .where('version', '=', tenant.hintVersion)
                        .execute()
                }
            })
    } catch (error) {
        console.warn(`SSSB tick: could not raise tenant ${tenant.id}'s ${drain} hint: ${messageOf(error)}`)
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
