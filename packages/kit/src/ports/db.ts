import type { Kysely, Transaction } from 'kysely'
import type { DB } from '../db/schema'

/**
 * How a database adapter keeps one tenant's rows from another's (ADR-0015, second addendum, point 3).
 *
 * - `'rls'`: row-level security. Every tenant table's policy compares `tenant_id` with the tenant `withTenant` set for
 *   the transaction, under a role that cannot bypass it, proven by the isolation proof suite on pglite and on real
 *   Postgres (ADR-0004). Every transport SSSB ships declares it.
 *
 * Other arrangements (a database per tenant, a single-tenant deployment, an unenforced filter chosen by name) join this
 * union with the database family that has the mechanism and the proofs for them, never before: a declared guarantee
 * with nothing behind it is not allowed.
 */
export type DbIsolation = 'rls'

/**
 * Database port (ADR-0002, ADR-0004). All tenant-scoped access goes through withTenant, which
 * runs fn inside a transaction whose first statements set the app_user role and tenant context —
 * RLS does the enforcement, not query discipline. The raw db handle is for tenant-less tables
 * and infrastructure work only.
 */
export interface DbPort {
    /**
     * The tenant isolation this adapter gives, declared rather than implied. Required: an adapter that does not say
     * how it isolates tenants is not one SSSB can make a promise about. A test double states the guarantee of the
     * adapter it stands in for (`'rls'` for any of SSSB's).
     */
    readonly isolation: DbIsolation
    getDb(): Kysely<DB>
    withTenant<T>(tenantId: string, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T>
    /** Resolves once the database is usable (fake: migrated + seeded). Await before raw getDb reads. */
    ready(): Promise<void>
    /** Applies pending migrations (dev boot, tests, and the migrator Lambda all share this). */
    migrateToLatest(): Promise<void>
    /**
     * The instant to stamp on a row whose time the FRAMEWORK writes (today only the audit trail's `at`,
     * `recordAuditEvent`), when the database's own clock is not the world's.
     *
     * The fake database sets it to the Simulator's world clock, so a demo that advances time sees new events
     * dated in that time. A real adapter must leave it undefined: Postgres `now()` is then the only clock, and
     * nothing a caller passes can set an audit row's time. It is a property of the PORT, not an argument of
     * `recordAuditEvent`, for exactly that reason: there is no `at` for a route to supply or forge.
     */
    now?(): Date
}
