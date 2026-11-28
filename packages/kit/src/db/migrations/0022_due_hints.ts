import { Kysely, sql } from 'kysely'

/**
 * WHEN EACH TENANT MAY NEXT HAVE DUE WORK, for the scheduled tick's drains (safeinsights/sssb#202). A drain lists a
 * tenant's due rows inside `withTenant`, one transaction per tenant (FORCE RLS leaves no cross-tenant read), which
 * costs four Data API calls a tenant a drain whether or not anything is due. `due_hints` lets a drain skip the tenants
 * that cannot have any: one row per (tenant, drain), `list_after` the earliest instant that tenant may have work due.
 *
 * - TRIGGERS LOWER IT. Every write that can make work due SOONER fires `sssb_note_due`, which lowers the tenant's
 *   `list_after` to the row's due time (never raises it) and bumps `version`: a row inserted eligible, or updated to
 *   become eligible or to fall due earlier (a schedule's `next_run_at`, `enabled`; a delivery's `next_attempt_at`,
 *   `status`; a retry's `run_after`, `status`). A write that moves an eligible row later (the tick's own advance and
 *   claims) does not fire (the triggers' WHEN clauses below say why). A trigger sees every write, the app's own
 *   included, so no write path has to remember to. A trigger that finds no row for the tenant cannot know what else
 *   the tenant has due, so it writes the epoch ("unknown": the tenant is listed), never the one row's time.
 * - THE DRAIN RAISES IT, and only by compare-and-set: after listing a tenant that had nothing due it moves
 *   `list_after` to the tenant's next due time, but only while `version` is what it read before listing, so a write
 *   that lowered the hint meanwhile is never overwritten (../due-hints.ts).
 * - A tenant with no row, or whose row says "unknown", is listed. This migration writes "unknown" rows for every
 *   tenant there is, one per drain, so the first tick lists everyone, as before, and the drains raise rows that exist.
 *   A raise only updates an existing row with SKIP LOCKED, which never waits; creating one is an insert, which waits
 *   on a tenant's open transaction whose trigger is inserting the same key. The backfill keeps that wait to a tenant
 *   created after this migration, on its first raise per drain, while a write of its own is open.
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
    // Every tenant there is gets its rows now, "unknown" (the epoch: listed on the first tick, then raised), so the
    // tick's raises after this migration update rows rather than create them, and never wait (see above).
    await sql`
        INSERT INTO due_hints (tenant_id, drain, list_after, version)
        SELECT t.id, d.drain, '1970-01-01T00:00:00Z'::timestamptz, 0
        FROM tenants t CROSS JOIN (VALUES ('schedules'), ('retries'), ('deliveries')) AS d (drain)
    `.execute(db)

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

    // INSERT and UPDATE apart, so an update fires only when it can make work due SOONER: a row becoming eligible, or
    // its due time moving earlier. One that moves an eligible row later (the tick's own advance of a schedule, its claim
    // of a delivery) cannot hide work from a raise (whatever a raise saw of the row, it was no later than now), so it
    // leaves the hint row alone, and the tick never waits on a tenant's transaction that holds it.
    for (const statement of [
        sql`CREATE TRIGGER job_schedules_note_due_insert AFTER INSERT ON job_schedules
            FOR EACH ROW WHEN (NEW.enabled) EXECUTE FUNCTION sssb_note_due('schedules')`,
        sql`CREATE TRIGGER job_schedules_note_due_update AFTER UPDATE OF next_run_at, enabled ON job_schedules
            FOR EACH ROW WHEN (NEW.enabled AND (NOT OLD.enabled OR NEW.next_run_at < OLD.next_run_at))
            EXECUTE FUNCTION sssb_note_due('schedules')`,
        sql`CREATE TRIGGER webhook_deliveries_note_due_insert AFTER INSERT ON webhook_deliveries
            FOR EACH ROW WHEN (NEW.status IN ('pending', 'failed')) EXECUTE FUNCTION sssb_note_due('deliveries')`,
        sql`CREATE TRIGGER webhook_deliveries_note_due_update AFTER UPDATE OF next_attempt_at, status ON webhook_deliveries
            FOR EACH ROW WHEN (
                NEW.status IN ('pending', 'failed')
                AND (OLD.status NOT IN ('pending', 'failed') OR NEW.next_attempt_at < OLD.next_attempt_at)
            ) EXECUTE FUNCTION sssb_note_due('deliveries')`,
        sql`CREATE TRIGGER jobs_note_due_insert AFTER INSERT ON jobs
            FOR EACH ROW WHEN (NEW.run_after IS NOT NULL AND NEW.status = 'queued')
            EXECUTE FUNCTION sssb_note_due('retries')`,
        sql`CREATE TRIGGER jobs_note_due_update AFTER UPDATE OF run_after, status ON jobs
            FOR EACH ROW WHEN (
                NEW.run_after IS NOT NULL AND NEW.status = 'queued'
                AND (OLD.run_after IS NULL OR OLD.status <> 'queued' OR NEW.run_after < OLD.run_after)
            ) EXECUTE FUNCTION sssb_note_due('retries')`,
    ]) {
        await statement.execute(db)
    }
}

export async function down(db: Kysely<any>): Promise<void> {
    for (const [trigger, table] of [
        ['jobs_note_due_update', 'jobs'],
        ['jobs_note_due_insert', 'jobs'],
        ['webhook_deliveries_note_due_update', 'webhook_deliveries'],
        ['webhook_deliveries_note_due_insert', 'webhook_deliveries'],
        ['job_schedules_note_due_update', 'job_schedules'],
        ['job_schedules_note_due_insert', 'job_schedules'],
    ] as const) {
        await sql`DROP TRIGGER ${sql.id(trigger)} ON ${sql.id(table)}`.execute(db)
    }
    await sql`DROP FUNCTION sssb_note_due()`.execute(db)
    await sql`DROP TABLE due_hints`.execute(db)
}
