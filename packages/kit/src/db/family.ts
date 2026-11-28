import { type Kysely, type RawBuilder, type SelectQueryBuilder, sql, type SqlBool, type Transaction } from 'kysely'
import type { KeysetPosition } from '../core/keyset'
import type { DbIsolation } from '../ports/db'
import { jsonb } from './jsonb'
import type { DB } from './schema'
import { runWithTenant } from './with-tenant'

/**
 * The database family (ADR-0015, second addendum, point 3): what is specific to one database engine, gathered behind
 * one object so the framework's logic stays generic over the engine. SSSB has one family today, Postgres, with three
 * transports (pglite, node-postgres, the RDS Data API); a second family (libsql, safeinsights/sssb#174)
 * is a second object of this shape, not a fork of the data layer.
 *
 * A family owns:
 *
 *  - its DIALECT HELPERS, the few places the framework's runtime logic needs engine SQL: encoding a JSON value, locking
 *    a row for the rest of the transaction, the database's own clock, and the keyset ordering. The framework's data
 *    modules (`./jobs.ts`, `./schedules.ts`, `./webhooks.ts`, `./audit.ts`, `./notifications.ts`, `./keyset.ts`) call
 *    these and write no engine SQL of their own; `tests/lint/db-family-fence.test.ts` holds them to it;
 *  - its ISOLATION, the guarantee every one of its transports declares as `DbPort.isolation`;
 *  - its TENANT SCOPE, the mechanism behind `DbPort.withTenant` that every one of its transports runs;
 *  - its MIGRATIONS (`./migrations/`) and its MIGRATOR (`./migrate.ts`), which reads the engine's own bookkeeping;
 *  - its ISOLATION PROOFS, the framework's half and the app's (`./family-suite.ts` says what each is, and why the
 *    app's belongs to its family too);
 *  - its catalog-reading tooling (`./app-roles.ts`, the conformance suite's schema reads, the contract server).
 *
 * The family comes in two halves, by who imports them. This module is the RUNTIME half: the data modules and the
 * transports import it on the request path, so it imports nothing but Kysely, `./jsonb` and `./with-tenant`, statically
 * or by `import()`: a bundler follows a literal `import()` into the server build. The SUITE half, `./family-suite.ts`,
 * loads the migrations, the migrator and the proofs for the conformance suite and the contract runner.
 *
 * Today's modules are referenced where they stand, not moved: docs cite them by path.
 *
 * Choosing a family from the app's declaration comes with the second family. Until then `family` is Postgres.
 */
export interface DbFamily {
    readonly name: string
    /** What its transports declare as `DbPort.isolation`: how the database keeps one tenant from another. */
    readonly isolation: DbIsolation
    /** A JSON value as a column parameter (`jsonb` in Postgres), safe for an array as well as an object. */
    json<T>(value: T): RawBuilder<T>
    /**
     * The tick's due-hint read (./due-hints.ts, 0022_due_hints): the tenants `drain` lists at `now` (no hint, a hint
     * that has come or is past `cap`, or an event that has come), each with its hint's version, and a token for the read
     * (`snapshot`: in Postgres the first page's `pg_current_snapshot()`, the earliest, so an event it can see was
     * committed before any tenant is listed). `everyone` reads every tenant with its hint's version and no events: the
     * fallback when the full read fails, so a drain that lists everyone can still settle. Paged by tenant id
     * (`DUE_HINTS_PAGE` a statement), so no response grows with the number of tenants. On the owner's raw handle. Each of these due-hint
     * statements runs in a transaction of its own that gives up after `timeoutMs` (it throws then) and lets the
     * planner use only index paths over the events (`dueHintsPlanner`).
     */
    readDueHints(
        db: Kysely<DB>,
        drain: string,
        now: Date,
        cap: Date,
        timeoutMs: number,
        everyone: boolean,
    ): Promise<{ tenants: { id: string; version: string | number | null }[]; snapshot: string | null }>
    /**
     * Sets the listed tenants' hints for `drain` by compare-and-set on the version each was read at (an insert when none
     * was), and deletes up to `limit` of their events that the read identified by `snapshot` could see. Returns the
     * tenants it set and how many events it deleted. One statement.
     */
    settleDueHints(
        db: Kysely<DB>,
        drain: string,
        snapshot: string,
        rows: readonly { tenantId: string; listAfter: Date; version: string | null }[],
        limit: number,
        timeoutMs: number,
    ): Promise<{ settled: string[]; deleted: number }>
    /** Deletes up to `limit` more of `tenantIds`' events for `drain` that `snapshot` could see; returns how many. */
    clearDueHintEvents(
        db: Kysely<DB>,
        drain: string,
        snapshot: string,
        tenantIds: readonly string[],
        limit: number,
        timeoutMs: number,
    ): Promise<number>
    /** The selected rows, locked for the rest of the transaction (`FOR UPDATE` in Postgres). Use with `$call`. */
    lockRow<D, TB extends keyof D, O>(query: SelectQueryBuilder<D, TB, O>): SelectQueryBuilder<D, TB, O>
    /** The database's own clock, as a value to write (`now()` in Postgres: the transaction's start). */
    currentTime(): RawBuilder<string>
    /**
     * One page of a keyset read: `query`'s rows after `after` (or the first page), newest first by `orderColumn` then
     * `id`, at most `take` of them, each with `keyset_at`, the ordering instant as an ISO-8601 UTC string to the
     * microsecond (the cursor's `at`). `./keyset.ts` owns the paging itself: the clamp, the probe row, the cursor.
     */
    keysetSlice<TB extends keyof DB, O>(
        query: SelectQueryBuilder<DB, TB, O>,
        page: { orderColumn: string; after: KeysetPosition | null; take: number },
    ): SelectQueryBuilder<DB, TB, O & { keyset_at: string }>
    /** The tenant scope every transport's `withTenant` runs: `fn` inside one transaction scoped to `tenantId`. */
    runWithTenant<T>(db: Kysely<DB>, tenantId: string, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T>
}

/**
 * The due hints' read (0022_due_hints), as one statement. Which tenants have an event that has come is found a tenant
 * at a time, never an event at a time: a skip along the `(drain, tenant_id)` index to the next tenant with any event,
 * then that tenant's earliest due time from the `(tenant_id, drain, due)` index, each one probe. Its cost grows with the
 * number of tenants that have events, not with how many any one of them has, so no pile, however big, slows the read
 * (and a planner that knows where the past-due events are cannot turn it into a scan of the events per tenant).
 * Exported for the plan check in ./due-hints.contract.test.ts.
 */
export function dueHintsReadQuery(drain: string, now: Date, cap: Date, after: string | null = null, everyone = false) {
    return sql<{ id: string; version: string | number | null; snapshot: string }>`
        WITH RECURSIVE with_events (tenant_id) AS (
            (SELECT e.tenant_id FROM public.due_hint_events e WHERE e.drain = ${drain} AND NOT ${everyone}
             ORDER BY e.tenant_id LIMIT 1)
            UNION ALL
            SELECT (
                SELECT e.tenant_id FROM public.due_hint_events e
                WHERE e.drain = ${drain} AND e.tenant_id > w.tenant_id
                ORDER BY e.tenant_id LIMIT 1
            )
            FROM with_events w WHERE w.tenant_id IS NOT NULL
        ),
        come AS (
            SELECT w.tenant_id FROM with_events w
            WHERE w.tenant_id IS NOT NULL AND (
                SELECT min(e.due) FROM public.due_hint_events e
                WHERE e.tenant_id = w.tenant_id AND e.drain = ${drain}
            ) <= ${now}
        )
        SELECT t.id, h.version, pg_current_snapshot()::text AS snapshot
        FROM public.tenants t
        LEFT JOIN public.due_hints h ON h.tenant_id = t.id AND h.drain = ${drain}
        LEFT JOIN come ON come.tenant_id = t.id
        WHERE (${everyone} OR h.tenant_id IS NULL OR h.list_after <= ${now} OR h.list_after > ${cap}
                OR come.tenant_id IS NOT NULL)
            AND (${after}::uuid IS NULL OR t.id > ${after}::uuid)
        ORDER BY t.id
        LIMIT ${DUE_HINTS_PAGE}
    `
}

/** How many tenants one page of the due-hint read returns, so no response grows with the number of tenants. */
export const DUE_HINTS_PAGE = 2_000

/**
 * The settings every due-hint statement runs under, in a transaction of its own: a `statement_timeout` (lock waits
 * count against it), and no sequential or bitmap scans, so the planner can only walk the events' indexes, which stop at
 * a statement's LIMIT. Without that, statistics that put most events in one tenant lead it to scan, or bitmap-and-sort,
 * that tenant's whole pile for each probe (a review measured 8.6 s for the read and 260 ms a delete). Exported for the
 * plan check in ./due-hints.contract.test.ts.
 */
export function dueHintsPlanner(timeoutMs: number) {
    return sql`
        SELECT set_config('statement_timeout', ${String(Math.max(1, Math.floor(timeoutMs)))}, true),
            set_config('enable_seqscan', 'off', true), set_config('enable_bitmapscan', 'off', true)
    `
}

/** Runs `run` in a transaction of its own under `dueHintsPlanner(timeoutMs)`. */
function bounded<T>(db: Kysely<DB>, timeoutMs: number, run: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    return db.transaction().execute(async (trx) => {
        await dueHintsPlanner(timeoutMs).execute(trx)
        return run(trx)
    })
}

/**
 * The row ids of at most `limit` events of the tenants `tenants` selects, for `drain`, that `snapshot` could see: read
 * tenant by tenant along the `(tenant_id, drain, due)` index, stopping at `limit` in all.
 */
function visibleEvents(tenants: RawBuilder<unknown>, drain: string, snapshot: string, limit: number) {
    return sql`
        SELECT x.ctid FROM (${tenants}) s
        CROSS JOIN LATERAL (
            SELECT e.ctid FROM public.due_hint_events e
            WHERE e.tenant_id = s.tenant_id AND e.drain = ${drain}
                AND pg_visible_in_snapshot(e.writer, ${snapshot}::pg_snapshot)
            ORDER BY e.due
            LIMIT ${limit}
        ) x
        LIMIT ${limit}
    `
}

const postgresFamily: DbFamily = {
    name: 'postgres',
    // Row-level security: every tenant table's policy compares `tenant_id` with the transaction's tenant setting,
    // under a role that cannot bypass it (ADR-0004).
    isolation: 'rls',
    json: jsonb,
    lockRow: (query) => query.forUpdate(),
    readDueHints: (db, drain, now, cap, timeoutMs, everyone) =>
        // A read that cannot finish inside the drain's window throws rather than hangs; the caller falls back.
        bounded(db, timeoutMs, async (trx) => {
            const tenants: { id: string; version: string | number | null }[] = []
            let snapshot: string | null = null
            let after: string | null = null
            for (;;) {
                const page: { id: string; version: string | number | null; snapshot: string }[] = (
                    await dueHintsReadQuery(drain, now, cap, after, everyone).execute(trx)
                ).rows
                if (snapshot === null && page.length > 0) snapshot = page[0]!.snapshot
                for (const row of page) tenants.push({ id: row.id, version: row.version })
                if (page.length < DUE_HINTS_PAGE) return { tenants, snapshot }
                after = page.at(-1)!.id
            }
        }),
    settleDueHints: (db, drain, snapshot, rows, limit, timeoutMs) =>
        bounded(db, timeoutMs, async (trx) => {
            const values = sql.join(
                rows.map((r) => sql`(${r.tenantId}::uuid, ${r.listAfter}::timestamptz, ${r.version}::bigint)`),
            )
            // An event the snapshot could not see was committed after the read: its tenant's listing may not have seen
            // its row, so it stays, and the tenant is listed again.
            const result = await sql<{ tenant_id: string | null; deleted: string | number }>`
            WITH v (tenant_id, list_after, version) AS (VALUES ${values}),
            updated AS (
                UPDATE public.due_hints h SET list_after = v.list_after, version = h.version + 1
                FROM v
                WHERE v.version IS NOT NULL AND h.tenant_id = v.tenant_id AND h.drain = ${drain}
                    AND h.version = v.version
                RETURNING h.tenant_id
            ),
            inserted AS (
                INSERT INTO public.due_hints (tenant_id, drain, list_after, version)
                SELECT v.tenant_id, ${drain}, v.list_after, 1 FROM v WHERE v.version IS NULL
                ON CONFLICT (tenant_id, drain) DO NOTHING
                RETURNING tenant_id
            ),
            settled AS (SELECT tenant_id FROM updated UNION ALL SELECT tenant_id FROM inserted),
            removed AS (
                DELETE FROM public.due_hint_events d
                WHERE d.ctid = ANY (ARRAY(${visibleEvents(sql`SELECT tenant_id FROM settled`, drain, snapshot, limit)}))
                RETURNING 1
            )
            SELECT s.tenant_id, (SELECT count(*) FROM removed) AS deleted
            FROM (SELECT tenant_id FROM settled UNION ALL SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM settled)) s
        `.execute(trx)
            return {
                settled: result.rows.flatMap((r) => (r.tenant_id === null ? [] : [r.tenant_id])),
                deleted: Number(result.rows[0]?.deleted ?? 0),
            }
        }),
    clearDueHintEvents: async (db, drain, snapshot, tenantIds, limit, timeoutMs) => {
        if (tenantIds.length === 0) return 0
        const ids = sql.join(tenantIds.map((id) => sql`(${id}::uuid)`))
        const result = sql<{ deleted: string | number }>`
            WITH removed AS (
                DELETE FROM public.due_hint_events d
                WHERE d.ctid = ANY (ARRAY(${visibleEvents(
                    sql`SELECT tenant_id FROM (VALUES ${ids}) AS t (tenant_id)`,
                    drain,
                    snapshot,
                    limit,
                )}))
                RETURNING 1
            )
            SELECT count(*) AS deleted FROM removed
        `
        return bounded(db, timeoutMs, async (trx) => Number((await result.execute(trx)).rows[0]?.deleted ?? 0))
    },
    currentTime: () => sql<string>`now()`,
    keysetSlice: (query, { orderColumn, after, take }) => {
        // ONE reference to the ordering column, used by the comparison, the cursor rendering and the ORDER BY.
        // `sql.ref` quotes it as an identifier; `./keyset.ts`'s type restricted it to a real column of the table, and
        // nothing from a request ever reaches it. Both halves of `after` are bound parameters, pattern-checked before
        // they got here (`parseDbKeysetCursor`).
        const orderRef = sql.ref(orderColumn)
        const windowed = after
            ? query.where(sql<SqlBool>`(${orderRef}, id) < (${after.at}::timestamptz, ${after.id}::uuid)`)
            : query
        return windowed
            .select(
                sql<string>`to_char(${orderRef} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('keyset_at'),
            )
            .orderBy(orderRef, 'desc')
            .orderBy(sql`id`, 'desc')
            .limit(take)
    },
    runWithTenant,
}

/**
 * The family the framework runs on: its data modules' dialect helpers, and its transports' isolation and tenant scope.
 * Postgres, the one family today; choosing it from the app's declaration arrives with a second.
 */
export const family: DbFamily = postgresFamily
