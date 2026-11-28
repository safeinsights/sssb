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
     * (`snapshot`: in Postgres the statement's `pg_current_snapshot()`). On the owner's raw handle.
     */
    readDueHints(
        db: Kysely<DB>,
        drain: string,
        now: Date,
        cap: Date,
    ): Promise<{ id: string; version: string | number | null; snapshot: string }[]>
    /**
     * Sets the listed tenants' hints for `drain` by compare-and-set on the version each was read at (an insert when none
     * was), and deletes, for each tenant it set, at most `perTenant` of its events that the read identified by `snapshot`
     * could see. One statement.
     */
    settleDueHints(
        db: Kysely<DB>,
        drain: string,
        snapshot: string,
        rows: readonly { tenantId: string; listAfter: Date; version: string | null }[],
        perTenant: number,
    ): Promise<void>
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

const postgresFamily: DbFamily = {
    name: 'postgres',
    // Row-level security: every tenant table's policy compares `tenant_id` with the transaction's tenant setting,
    // under a role that cannot bypass it (ADR-0004).
    isolation: 'rls',
    json: jsonb,
    lockRow: (query) => query.forUpdate(),
    readDueHints: async (db, drain, now, cap) =>
        (
            await sql<{ id: string; version: string | number | null; snapshot: string }>`
                SELECT t.id, h.version, pg_current_snapshot()::text AS snapshot
                FROM public.tenants t
                LEFT JOIN public.due_hints h ON h.tenant_id = t.id AND h.drain = ${drain}
                WHERE h.tenant_id IS NULL OR h.list_after <= ${now} OR h.list_after > ${cap}
                    OR EXISTS (
                        SELECT 1 FROM public.due_hint_events e
                        WHERE e.tenant_id = t.id AND e.drain = ${drain} AND e.due <= ${now}
                    )
            `.execute(db)
        ).rows,
    settleDueHints: async (db, drain, snapshot, rows, perTenant) => {
        const values = sql.join(
            rows.map((r) => sql`(${r.tenantId}::uuid, ${r.listAfter}::timestamptz, ${r.version}::bigint)`),
        )
        // An event the snapshot could not see was committed after the read: its tenant's listing may not have seen
        // its row, so it stays, and the tenant is listed again. At most `perTenant` a tenant, read along the events
        // index, so one tenant's backlog costs this statement no more than any other's; the rest stay, and only mean
        // the tenant is listed again.
        await sql`
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
            )
            DELETE FROM public.due_hint_events d
            WHERE d.ctid = ANY (ARRAY(
                SELECT x.ctid
                FROM (SELECT tenant_id FROM updated UNION ALL SELECT tenant_id FROM inserted) s
                CROSS JOIN LATERAL (
                    SELECT e.ctid FROM public.due_hint_events e
                    WHERE e.tenant_id = s.tenant_id AND e.drain = ${drain}
                        AND pg_visible_in_snapshot(e.writer, ${snapshot}::pg_snapshot)
                    ORDER BY e.due
                    LIMIT ${perTenant}
                ) x
            ))
        `.execute(db)
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
