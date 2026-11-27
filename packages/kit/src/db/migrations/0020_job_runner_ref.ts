import { Kysely, sql } from 'kysely'

/**
 * The runner's own name for the run behind a job (safeinsights/sssb#231): for the CodeBuild runner, the build's id, so
 * its sweep can ask CodeBuild what became of a build that never reported back.
 *
 * - NULLABLE, no default. NULL means no runner recorded one: every row written before this migration, and every job
 *   another runner holds. The CodeBuild runner writes `starting` before it calls StartBuild and the build's id once it
 *   returns, so a row it never got past `starting` is one whose start never reached CodeBuild, or was never recorded.
 * - Plain text: an id of another system's, not a row here.
 * - The grant is unchanged: table-level grants cover columns added later (as in 0014, 0016, 0017 and 0019).
 *
 * It names the one table it touches (the order-independence rule in ./index.ts).
 */
export async function up(db: Kysely<any>): Promise<void> {
    await sql`ALTER TABLE jobs ADD COLUMN runner_ref text`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
    await sql`ALTER TABLE jobs DROP COLUMN runner_ref`.execute(db)
}
