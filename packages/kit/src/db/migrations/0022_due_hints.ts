import { Kysely, sql } from 'kysely'

/**
 * WHEN EACH TENANT MAY NEXT HAVE DUE WORK, for the scheduled tick's drains (safeinsights/sssb#202). A drain lists a
 * tenant's due rows inside `withTenant`, one transaction per tenant (FORCE RLS leaves no cross-tenant read), which
 * costs four Data API calls a tenant a drain whether or not anything is due. `due_hints` lets a drain skip the tenants
 * that cannot have any: one row per (tenant, drain), `list_after` the earliest instant that tenant may have work due.
 *
 * - TRIGGERS LOWER IT. Every write that can make work due fires `sssb_note_due`, which lowers the tenant's
 *   `list_after` to the row's due time (never raises it) and bumps `version`: a schedule enabled or moved
 *   (`job_schedules.next_run_at`, `enabled`), a delivery pending or failed (`webhook_deliveries.next_attempt_at`,
 *   `status`), a retry waiting (`jobs.run_after`, `status`, queued). A trigger sees every write, the app's own
 *   included, so no write path has to remember to. A trigger that finds no row for the tenant cannot know what else
 *   the tenant has due, so it writes the epoch ("unknown": the tenant is listed), never the one row's time.
 * - THE DRAIN RAISES IT, and only by compare-and-set: after listing a tenant that had nothing due it moves
 *   `list_after` to the tenant's next due time, but only while `version` is what it read before listing, so a write
 *   that lowered the hint meanwhile is never overwritten (../due-hints.ts).
 * - A tenant with no row, or whose row says "unknown", is listed. Every tenant starts without one, so this migration
 *   backfills nothing: the first tick lists everyone, as before, and the drains raise the rows.
 *
 * NOT REACHABLE BY `app_user`. The table has no grant to it (a cross-tenant table it could read would tell one tenant
 * when another has work), and so needs no RLS (./rls-coverage.ts covers what `app_user` can reach). Only the
 * migration owner, the role the server connects as, reads and writes it, through the tick's raw handle; and the
 * trigger function, which is SECURITY DEFINER for that reason, with its `search_path` pinned and EXECUTE revoked from
 * PUBLIC (a trigger function cannot be called directly in any case). What the function writes comes only from the
 * row being written, which RLS has already confined to the writer's tenant.
 *
 * It names every object it touches (the order-independence rule in ./index.ts).
 */
export async function up(db: Kysely<any>): Promise<void> {
    await sql`
        CREATE TABLE due_hints (
            tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            drain text NOT NULL CHECK (drain IN ('schedules', 'retries', 'deliveries')),
            list_after timestamptz NOT NULL,
            version bigint NOT NULL DEFAULT 0,
            PRIMARY KEY (tenant_id, drain)
        )
    `.execute(db)
    await sql`REVOKE ALL ON due_hints FROM PUBLIC`.execute(db)
    // Named too, so a default privilege an app migration gave app_user before this one cannot reach the table.
    await sql`REVOKE ALL ON due_hints FROM app_user`.execute(db)

    await sql`
        CREATE FUNCTION sssb_note_due() RETURNS trigger
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog, public, pg_temp
        AS $$
        DECLARE
            due timestamptz;
        BEGIN
            IF TG_TABLE_NAME = 'job_schedules' THEN
                due := NEW.next_run_at;
            ELSIF TG_TABLE_NAME = 'webhook_deliveries' THEN
                due := NEW.next_attempt_at;
            ELSE
                due := NEW.run_after;
            END IF;
            -- With no row yet, the tenant may hold earlier due work this row says nothing of: the row records "unknown"
            -- (the epoch, so the tenant is listed) and the drain's raise sets it. An existing row is only lowered.
            INSERT INTO public.due_hints AS h (tenant_id, drain, list_after, version)
            VALUES (NEW.tenant_id, TG_ARGV[0], '1970-01-01T00:00:00Z'::timestamptz, 1)
            ON CONFLICT (tenant_id, drain) DO UPDATE
                SET list_after = LEAST(h.list_after, due), version = h.version + 1;
            RETURN NULL;
        END
        $$
    `.execute(db)
    await sql`REVOKE ALL ON FUNCTION sssb_note_due() FROM PUBLIC`.execute(db)
    await sql`REVOKE ALL ON FUNCTION sssb_note_due() FROM app_user`.execute(db)

    await sql`
        CREATE TRIGGER job_schedules_note_due
        AFTER INSERT OR UPDATE OF next_run_at, enabled ON job_schedules
        FOR EACH ROW WHEN (NEW.enabled)
        EXECUTE FUNCTION sssb_note_due('schedules')
    `.execute(db)
    await sql`
        CREATE TRIGGER webhook_deliveries_note_due
        AFTER INSERT OR UPDATE OF next_attempt_at, status ON webhook_deliveries
        FOR EACH ROW WHEN (NEW.status IN ('pending', 'failed'))
        EXECUTE FUNCTION sssb_note_due('deliveries')
    `.execute(db)
    await sql`
        CREATE TRIGGER jobs_note_due
        AFTER INSERT OR UPDATE OF run_after, status ON jobs
        FOR EACH ROW WHEN (NEW.run_after IS NOT NULL AND NEW.status = 'queued')
        EXECUTE FUNCTION sssb_note_due('retries')
    `.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
    await sql`DROP TRIGGER jobs_note_due ON jobs`.execute(db)
    await sql`DROP TRIGGER webhook_deliveries_note_due ON webhook_deliveries`.execute(db)
    await sql`DROP TRIGGER job_schedules_note_due ON job_schedules`.execute(db)
    await sql`DROP FUNCTION sssb_note_due()`.execute(db)
    await sql`DROP TABLE due_hints`.execute(db)
}
