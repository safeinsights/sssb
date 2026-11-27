import { Kysely, sql } from 'kysely'

/**
 * What a schedule's failed spawns leave behind (safeinsights/sssb#215), so a schedule that keeps failing backs off, and
 * one that can never succeed is turned off and says why:
 *
 * - `failure_count`: spawns in a row that failed inside the spawn transaction, reset to 0 by the next one that
 *   commits. Every existing row starts at 0.
 * - `last_error`: the latest such failure's message; NULL once a spawn commits again, and on every existing row.
 *
 * The grant is unchanged: table-level grants cover columns added later (as in 0014, 0016, 0017, 0019 and 0020).
 *
 * It names the one table it touches (the order-independence rule in ./index.ts).
 */
export async function up(db: Kysely<any>): Promise<void> {
    await sql`ALTER TABLE job_schedules ADD COLUMN failure_count integer NOT NULL DEFAULT 0`.execute(db)
    await sql`ALTER TABLE job_schedules ADD COLUMN last_error text`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
    await sql`ALTER TABLE job_schedules DROP COLUMN last_error`.execute(db)
    await sql`ALTER TABLE job_schedules DROP COLUMN failure_count`.execute(db)
}
