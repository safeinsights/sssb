import { Kysely, sql } from 'kysely'

/**
 * WHO started a job: the user id of the person who submitted it, so the end of their job can reach them when the org
 * has no admin to tell (a fixed org source places everyone in one org with one role, so it has none).
 *
 * - NULLABLE, no default. NULL means "no person started it": a scheduled run, a job submitted by a service, and every
 *   row written before this migration.
 * - Plain text, no foreign key: user ids are the identity provider's, not a table here (as `audit_events`' actor).
 * - The grant is unchanged: table-level grants cover columns added later (as in 0014 and 0016).
 *
 * It names the one table it touches (the order-independence rule in ./index.ts).
 */
export async function up(db: Kysely<any>): Promise<void> {
    await sql`ALTER TABLE jobs ADD COLUMN requested_by text`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
    await sql`ALTER TABLE jobs DROP COLUMN requested_by`.execute(db)
}
