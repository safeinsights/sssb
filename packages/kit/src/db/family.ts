import { type Kysely, type RawBuilder, type SelectQueryBuilder, sql, type SqlBool, type Transaction } from 'kysely'
import type { KeysetPosition } from '../core/keyset'
import type { DbIsolation } from '../ports/db'
import { jsonb } from './jsonb'
import type { DB } from './schema'
import { runWithTenant } from './with-tenant'

/**
 * The database family (ADR-0015, second addendum, point 3): what is specific to one database engine, gathered behind
 * one object so the framework's logic stays generic over the engine. SSSB has one family today, Postgres, with three
 * transports (pglite, node-postgres, the RDS Data API); a second family (libsql, `.claude/future-tasks/db-libsql-family.md`)
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
 *  - its ISOLATION PROOFS: the framework's half (`./rls-proofs.ts`, `./rls-coverage.ts`, `./owner-pass.ts`, composed
 *    by `./rls-proof-runner.ts`) and the app's half. An app's own proofs (`src/app-config/db/rls-proofs.ts`, through
 *    the seam) belong to its family too: they switch roles and set the tenant the way this family's scope does, so an
 *    app on another database writes its proofs for that database;
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
