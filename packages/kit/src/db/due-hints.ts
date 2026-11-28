import type { DbPort } from '../ports/db'
import { family } from './family'

/**
 * Which tenants a drain of the scheduled tick lists (safeinsights/sssb#202). Each drain lists a tenant's due rows
 * inside `withTenant`, a transaction of its own, so listing every tenant costs every tenant those round trips on every
 * tick, whether or not anything is due: four Data API calls a tenant a drain. Migration 0022 keeps two owner-only
 * tables for it: `due_hints`, per tenant and drain the earliest instant that tenant may have work due as of the tick
 * that last listed it, and `due_hint_events`, one row per write that has made work due sooner since.
 *
 * A drain that uses them reads, in one query (`tenantsToList`), the tenants with no hint, a hint that has come, a hint
 * further off than `MAX_SKIP_MS` (a simulated world whose clock was moved back), or an event that has come, and the
 * snapshot that read was taken in. It lists those. Then, in one statement a drain (`settleHints`, one per 200 tenants), it
 * sets each listed tenant's hint: to the epoch when it had rows due (so it is listed again, whatever a Simulator's clock
 * does next), else to its next due time, at most `MAX_SKIP_MS` on; and deletes up to `EVENTS_SETTLED_PER_TENANT` of that
 * tenant's events the snapshot could see, which its listing has accounted for (any more stay, and it is listed again). An
 * event committed after the read stays, so its tenant is listed again: no write is lost to a tick that read before it.
 * The hint is set by compare-and-set on its version, so of two overlapping ticks only one sets it; the other deletes
 * nothing, and its tenants are listed again.
 *
 * Nothing here waits on a tenant: a tenant's writes only append events (no key, no lock to hold), and only the tick
 * writes `due_hints`.
 *
 * Read and written through the raw handle, schema-qualified (`public`, so a temporary table of the same name on a
 * pooled connection cannot stand in), as the tick already reads `tenants`: the tables belong to the migration owner,
 * the role the server connects as. A hint that cannot be read (a server connecting as some other role) is no reason
 * to skip anything: the drain lists every tenant, as before, and sets nothing (its events then stay:
 * safeinsights/sssb#308).
 */

export type DueDrain = 'schedules' | 'retries' | 'deliveries'

/** The longest a hint lets a drain leave a tenant unlisted: a day, so every tenant is listed at least once a day. */
export const MAX_SKIP_MS = 24 * 60 * 60_000

/** How many tenants one settling statement covers, so no statement grows past what a transport takes. */
const SETTLE_CHUNK = 200

/**
 * The most events one settling statement deletes. A settle deletes the events its listing accounted for a statement at
 * a time, as long as the drain's window lasts (and at most `MAX_CLEARING_STATEMENTS` more), so a tenant's pile is
 * cleared in proportion to its size while no one statement costs the tick more than this; what a window leaves stays,
 * which only means the tenant is listed again and settles more next tick.
 */
export const EVENTS_PER_STATEMENT = 10_000

/** The most clearing statements one settle runs after the first, whatever time is left. */
const MAX_CLEARING_STATEMENTS = 100

/**
 * The longest the read may take: half of what is left of the drain's window, never under 50 ms nor over 5 s. A read
 * that takes longer (a bad plan, a lock) gives up, and the drain lists every tenant, as it did before the hints.
 */
const READ_TIMEOUT_MAX_MS = 5_000
const READ_TIMEOUT_MIN_MS = 50

/** The drain's window, as `settleHints` and `tenantsToList` read it (a drain's budget is one). */
export interface HintWindow {
    deadline: number
    clock?: () => number
}

/** A tenant a drain lists, with the version of its hint as read (null when it has none). */
export interface HintedTenant {
    id: string
    hintVersion: string | null
    /** Set when the hints could not be read: the tenant is listed, and nothing is settled. */
    unhinted?: boolean
}

/** What a drain read: the tenants to list, and the snapshot the read was taken in (null when nothing was listed). */
export interface HintRead {
    tenants: HintedTenant[]
    snapshot: string | null
}

/** What a drain's listing of one tenant found: rows due now, or none and when it next has work (null: none). */
export interface ListedTenant {
    tenant: HintedTenant
    hadRows: boolean
    nextDue: Date | null
}

/**
 * The tenants `drain` lists at `now`, and the snapshot of the read. One query. Every tenant, marked unhinted, when the
 * hints cannot be read.
 */
export async function tenantsToList(
    db: DbPort,
    drain: DueDrain,
    now: Date,
    window: HintWindow = { deadline: Number.POSITIVE_INFINITY },
): Promise<HintRead> {
    const raw = db.getDb().withSchema('public')
    const cap = new Date(now.getTime() + MAX_SKIP_MS)
    try {
        const left = window.deadline - (window.clock ?? Date.now)()
        const timeoutMs = Number.isFinite(left)
            ? Math.min(READ_TIMEOUT_MAX_MS, Math.max(READ_TIMEOUT_MIN_MS, left / 2))
            : READ_TIMEOUT_MAX_MS
        const rows = await family.readDueHints(raw, drain, now, cap, timeoutMs)
        return {
            tenants: rows.map((r) => ({ id: r.id, hintVersion: r.version === null ? null : String(r.version) })),
            snapshot: rows[0]?.snapshot ?? null,
        }
    } catch (error) {
        console.warn(
            `SSSB tick: the ${drain} drain could not read its due hints, so it lists every tenant: ${messageOf(error)}`,
        )
        const all = await raw.selectFrom('tenants').select('id').execute()
        return { tenants: all.map((t) => ({ id: t.id, hintVersion: null, unhinted: true })), snapshot: null }
    }
}

/**
 * After a drain has listed `listed` (from `read`), sets each one's hint and deletes the events the read's snapshot
 * could see, by compare-and-set on the version read: a tenant another tick has set since keeps that tick's hint and its
 * events. One statement per `SETTLE_CHUNK` tenants. Never throws: a hint not set only means the tenant is listed again.
 */
export async function settleHints(
    db: DbPort,
    drain: DueDrain,
    now: Date,
    read: HintRead,
    listed: readonly ListedTenant[],
    window: HintWindow = { deadline: Number.POSITIVE_INFINITY },
): Promise<void> {
    const settled = listed.filter((l) => !l.tenant.unhinted)
    if (read.snapshot === null || settled.length === 0) return
    const cap = new Date(now.getTime() + MAX_SKIP_MS)
    const raw = db.getDb().withSchema('public')
    const set: string[] = []
    let more = false
    for (let i = 0; i < settled.length; i += SETTLE_CHUNK) {
        const rows = settled.slice(i, i + SETTLE_CHUNK).map((l) => ({
            tenantId: l.tenant.id,
            // A tenant listed with rows is listed again whatever the clock does next: the epoch, not `now`, which a
            // Simulator's clock reset can move back past.
            listAfter: l.hadRows
                ? LISTED_AGAIN
                : l.nextDue !== null && l.nextDue.getTime() < cap.getTime()
                  ? l.nextDue
                  : cap,
            version: l.tenant.hintVersion,
        }))
        try {
            const result = await family.settleDueHints(raw, drain, read.snapshot, rows, EVENTS_PER_STATEMENT)
            set.push(...result.settled)
            if (result.deleted >= EVENTS_PER_STATEMENT) more = true
        } catch (error) {
            console.warn(`SSSB tick: could not set the ${drain} drain's due hints: ${messageOf(error)}`)
        }
    }
    // The rest of the settled tenants' accounted-for events, a bounded statement at a time, while the window lasts.
    const clock = window.clock ?? Date.now
    for (let statements = 0; more && statements < MAX_CLEARING_STATEMENTS && clock() < window.deadline; statements++) {
        more = false
        for (let i = 0; i < set.length && clock() < window.deadline; i += SETTLE_CHUNK) {
            try {
                const deleted = await family.clearDueHintEvents(
                    raw,
                    drain,
                    read.snapshot,
                    set.slice(i, i + SETTLE_CHUNK),
                    EVENTS_PER_STATEMENT,
                )
                if (deleted >= EVENTS_PER_STATEMENT) more = true
            } catch (error) {
                console.warn(`SSSB tick: could not clear the ${drain} drain's due-hint events: ${messageOf(error)}`)
                return
            }
        }
    }
}

/** A hint that has always come: the tenant is listed by the next tick, whatever its clock. */
const LISTED_AGAIN = new Date(0)

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
