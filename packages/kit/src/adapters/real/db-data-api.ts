import { RDSDataClient } from '@aws-sdk/client-rds-data'
import { Kysely } from 'kysely'
import { migrateToLatest } from '../../db/migrate'
import type { DB } from '../../db/schema'
import { transactionKeepingWorkError } from '../../db/with-tenant'
import type { DbPort } from '../../ports/db'
import { dbPortFor } from './db-port'
import { lockMigrations, RdsDataDialect, type RdsDataClientLike } from './rds-data-dialect'

export interface DataApiDbConfig {
    /** The Aurora cluster's ARN; the cluster must have the Data API enabled. */
    resourceArn: string
    /** The Secrets Manager secret holding the database credentials the Data API connects with. */
    secretArn: string
    database: string
    /** Omitted: the SDK's own region resolution (AWS_REGION in Lambda). */
    region?: string
    /** Injected only by the contract suite, which runs the dialect against its emulator. */
    client?: RdsDataClientLike
    /** How long inferred parameter types are trusted; the dialect's `TYPE_CACHE_TTL_MS` when omitted. */
    typeCacheTtlMs?: number
    /** How long a call waits for a paused cluster to resume; the dialect's `RESUME_BUDGET_MS` when omitted. */
    resumeBudgetMs?: number | undefined
}

/**
 * The opt-in transport (`DATABASE_TRANSPORT=data-api`): the `db` port over the RDS Data API, for a
 * Lambda outside any VPC — no NAT, no socket, IAM instead of a network path (ADR-0002, addendum
 * 2026-11-16). AUTHORED — CUTOVER (`data-api`).
 *
 * Its own module, reached ONLY by dynamic import (./index.ts, ./migrate-handler.ts), so a `pg`
 * deployment never loads the RDS Data SDK; ./index.test.ts proves it.
 *
 * `maxAttempts: 1` turns the SDK's automatic retries off, on AWS's own advice: a statement whose call
 * timed out may still have finished, and retrying it can write twice. What is safe to
 * send again while a paused Serverless v2 resumes, the dialect sends again itself.
 */
export function createRealDataApiDb(config: DataApiDbConfig): DbPort {
    const client =
        config.client ??
        new RDSDataClient({ ...(config.region === undefined ? {} : { region: config.region }), maxAttempts: 1 })
    const dialect = new RdsDataDialect({
        client,
        resourceArn: config.resourceArn,
        secretArn: config.secretArn,
        database: config.database,
        typeCacheTtlMs: config.typeCacheTtlMs,
        resumeBudgetMs: config.resumeBudgetMs,
    })
    const db = new Kysely<DB>({ dialect })
    return {
        ...dbPortFor(db),
        // ONE explicit transaction for the whole run, opened with a transaction-scoped lock and handed to the
        // Migrator. Left to itself the Migrator locks on db.connection() — a separate Data API call whose
        // session-level lock the connection reset drops at once — and creates its bookkeeping tables before
        // locking at all (ADR-0002, addendum 2026-11-16). A second migrator waits on the lock, for at most
        // the Data API's 45-second call timeout, then fails loudly.
        async migrateToLatest() {
            // A migration that fails is the error the deploy must show, whatever the rollback after it does.
            await transactionKeepingWorkError(db, async (trx) => {
                await lockMigrations(trx)
                await migrateToLatest(trx)
            })
        },
    }
}
