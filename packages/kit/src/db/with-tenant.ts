import { sql, type Kysely, type Transaction } from 'kysely'
import type { DB } from './schema'

/**
 * The tenant scope helper every db transport shares (proven in spikes/kysely-pglite; ADR-0004).
 *
 * ONE statement sets both halves of the scope, transaction-locally: `set_config('role', 'app_user', true)`
 * is `SET LOCAL ROLE app_user` (same GUC, same check that the session user is a member) and the tenant id goes through
 * set_config() as a real parameter — never string interpolation. One statement rather than two because
 * on the RDS Data API every statement is its own HTTPS call (ADR-0004, addendum 2026-11-16); on `pg` and
 * pglite it is simply one round trip fewer. Transaction-scoped, so it is safe under pooling, required
 * under pglite (whose default user bypasses RLS), and the only shape that survives the Data API's
 * connection reset between transactions.
 *
 * If the work throws and the rollback that follows throws too, the work's error is the one thrown (safeinsights/sssb#189):
 * `transactionKeepingWorkError` below says how, and `keepRollbackFailure` what is kept of the other.
 */
export async function runWithTenant<T>(
    db: Kysely<DB>,
    tenantId: string,
    fn: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
    return transactionKeepingWorkError(db, async (trx) => {
        await sql`SELECT set_config('role', 'app_user', true), set_config('app.current_tenant', ${tenantId}, true)`.execute(
            trx,
        )
        return fn(trx)
    })
}

/**
 * `db.transaction().execute(work)`, except that when the work throws and the rollback Kysely then makes throws too, the
 * work's error is the one thrown (safeinsights/sssb#189). Otherwise the rollback's replaces it (a 403 becomes a 503 when
 * the Data API throttles the rollback; a migration's SQL error becomes "the database is unavailable"), and Kysely does
 * not say which of the two it is rethrowing. For the transactions the framework opens itself: `runWithTenant` and the
 * Data API transport's migrations. A rollback the caller makes (a controlled transaction's `rollback()`) calls the
 * driver without passing through here, and fails as it did.
 */
export async function transactionKeepingWorkError<T>(
    db: Kysely<DB>,
    work: (trx: Transaction<DB>) => Promise<T>,
): Promise<T> {
    let thrown: { readonly error: unknown } | undefined
    try {
        return await db.transaction().execute(async (trx) => {
            try {
                return await work(trx)
            } catch (error) {
                thrown = { error }
                throw error
            }
        })
    } catch (error) {
        // The work threw and something else was thrown after it: the rollback Kysely made because of it. The work's
        // error is the one the caller acts on; the rollback's is kept beside it.
        if (thrown !== undefined && error !== thrown.error) {
            keepRollbackFailure(thrown.error, error)
            throw thrown.error
        }
        throw error
    }
}

/**
 * Kept, not lost: a warning, and on the work's error (when it is an object that takes one) a non-enumerable
 * `rollbackError`.
 */
function keepRollbackFailure(work: unknown, rollback: unknown): void {
    const name = work instanceof Error ? work.name : typeof work
    const why = rollback instanceof Error ? `${rollback.name}: ${rollback.message}` : String(rollback)
    console.warn(
        `SSSB db: a transaction's rollback failed after its work threw ${name}; the work's error is thrown: ${why}`,
    )
    if (typeof work === 'object' && work !== null) {
        try {
            Object.defineProperty(work, 'rollbackError', {
                value: rollback,
                enumerable: false,
                configurable: true,
                writable: true,
            })
        } catch {
            // A frozen error takes nothing: the warning has it.
        }
    }
}
