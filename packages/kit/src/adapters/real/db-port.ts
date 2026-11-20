import type { Kysely, Transaction } from 'kysely'
import { migrateToLatest } from '../../db/migrate'
import type { DB } from '../../db/schema'
import { family } from '../../db/family'
import type { DbPort } from '../../ports/db'

/**
 * One port shape for both transports: they differ in how SQL reaches Postgres, never in what it says. Its own module,
 * apart from the `pg` transport (./db.ts), so the Data API transport (./db-data-api.ts) shares it without loading `pg`.
 */
export function dbPortFor(db: Kysely<DB>): DbPort {
    return {
        isolation: family.isolation,
        getDb() {
            return db
        },
        async ready() {
            // Real databases are provisioned/migrated by the deploy pipeline, not lazily.
        },
        async withTenant<T>(tenantId: string, fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
            return family.runWithTenant(db, tenantId, fn)
        },
        async migrateToLatest() {
            await migrateToLatest(db)
        },
    }
}
