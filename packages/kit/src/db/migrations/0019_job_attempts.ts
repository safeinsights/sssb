import { Kysely, sql } from 'kysely'

/**
 * A job kind that retries (safeinsights/sssb#135) runs each attempt as a NEW `jobs` row, so `failed` stays terminal and
 * every attempt keeps its own timeline. Three columns say where a row sits in that chain:
 *
 * - `attempt`: which attempt this row is, from 1. Every row written before this migration is attempt 1.
 * - `retry_of`: the FIRST attempt's id, on attempt 2 and later; NULL on attempt 1. It is the key a handler can
 *   deduplicate its side effects on (`ctx.firstJobId`), and how a list groups the attempts of one piece of work. A
 *   foreign key to `jobs`: an attempt cannot outlive the job it retries.
 * - `run_after`: on a retry still waiting out its backoff, when it may run; NULL on every other row. The scheduled
 *   tick's drain (`runDueRetries`) claims a due one by clearing it, and from then on the row is an ordinary queued job.
 *
 * Two partial indexes: one serves that drain's per-tenant listing, which reads only rows that are waiting; the other
 * finds a job's later attempts (how the notifier tells a failure that armed a retry from a job's end). The grant is
 * unchanged: table-level grants cover columns added later (as in 0014, 0016 and 0017). Numbered 0019 because 0018 is
 * taken by another branch's migration; migrations run unordered (../migrate.ts), so the gap is harmless.
 *
 * It names the one table it touches (the order-independence rule in ./index.ts).
 */
export async function up(db: Kysely<any>): Promise<void> {
    await sql`ALTER TABLE jobs ADD COLUMN attempt integer NOT NULL DEFAULT 1`.execute(db)
    await sql`ALTER TABLE jobs ADD COLUMN retry_of uuid REFERENCES jobs(id)`.execute(db)
    await sql`ALTER TABLE jobs ADD COLUMN run_after timestamptz`.execute(db)
    await sql`CREATE INDEX jobs_run_after_idx ON jobs (run_after) WHERE run_after IS NOT NULL`.execute(db)
    await sql`CREATE INDEX jobs_retry_of_idx ON jobs (retry_of) WHERE retry_of IS NOT NULL`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
    await sql`DROP INDEX jobs_retry_of_idx`.execute(db)
    await sql`DROP INDEX jobs_run_after_idx`.execute(db)
    await sql`ALTER TABLE jobs DROP COLUMN run_after`.execute(db)
    await sql`ALTER TABLE jobs DROP COLUMN retry_of`.execute(db)
    await sql`ALTER TABLE jobs DROP COLUMN attempt`.execute(db)
}
