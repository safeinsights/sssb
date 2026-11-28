import { Kysely, sql } from 'kysely'

/**
 * WHEN EACH TENANT MAY NEXT HAVE DUE WORK, for the scheduled tick's drains (safeinsights/sssb#202). A drain lists a
 * tenant's due rows inside `withTenant`, one transaction per tenant (FORCE RLS leaves no cross-tenant read), which
 * costs four Data API calls a tenant a drain whether or not anything is due. These two tables let a drain skip the
 * tenants that cannot have any.
 *
 * - `due_hints`: one row per (tenant, drain), `list_after` the earliest instant that tenant may have work due, as of
 *   the tick that last listed it. ONLY THE TICK WRITES IT (../due-hints.ts), after listing a tenant, by
 *   compare-and-set on `version` against an overlapping tick. A tenant with no row is listed.
 * - `due_hint_events`: one row for every write that makes work due SOONER (a row inserted eligible, or updated to
 *   become eligible or to fall due earlier: a schedule's `next_run_at`, `enabled`; a delivery's `next_attempt_at`,
 *   `status`; a retry's `run_after`, `status`), with that work's due time and the writing transaction. A trigger
 *   appends it, `sssb_note_due`, so no write path has to remember to. A tenant with an event that has come is listed.
 *   The tick deletes the events its listing has accounted for, and only those: the ones committed before the read it
 *   listed from (`writer`, against that read's snapshot), so an event committed since stays, and the tenant is listed
 *   again.
 *
 * WHY TWO TABLES. A write that lowered a shared hint row would hold that row's lock until its transaction ended, and
 * every other write of the tenant that makes work due, the tick's own (arming a retry, enqueueing a delivery)
 * included, would wait on it: an open tenant transaction could stall the tick for every tenant. An append has no key
 * to wait on. A tenant's write never touches `due_hints`, and the tick never waits on a tenant.
 *
 * A write that moves an eligible row later (the tick's own advance of a schedule, its claim of a delivery) appends
 * nothing: whatever the tick's listing saw of the row was due no later than now, so the hint it sets cannot hide it.
 *
 * NOT REACHABLE BY `app_user`, and so without RLS (./rls-coverage.ts covers what `app_user` can reach): a cross-tenant
 * table it could read would tell one tenant when another has work, and one it could write could hide another's work.
 * Only the migration owner, the role the server connects as, reads and writes them, through the tick's raw handle;
 * and the trigger function, which is SECURITY DEFINER for that reason, with its `search_path` pinned and EXECUTE
 * revoked (a trigger function cannot be called directly in any case). What it writes comes only from the row being
 * written, which RLS has already confined to the writer's tenant. On an upgrade this migration runs after the app's
 * own, so a default privilege an app migration set (to app_user, or to a role it is a member of) would reach these
 * objects: every grant on them but the owner's is revoked, and the migration refuses to finish if app_user can still
 * reach them.
 *
 * It names every object it touches (the order-independence rule in ./index.ts), and backfills nothing: a tenant with
 * no hint is listed, so the first tick lists everyone, as before, and writes their hints.
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
    await sql`
        CREATE TABLE due_hint_events (
            tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            drain text NOT NULL CHECK (drain IN ('schedules', 'retries', 'deliveries')),
            due timestamptz NOT NULL,
            writer xid8 NOT NULL DEFAULT pg_current_xact_id()
        )
    `.execute(db)
    // Per tenant and due time, for a tenant's earliest event and the tick's deletes; per drain and tenant, for the
    // tick's read of which tenants have events at all, a tenant at a time (../due-hints.ts).
    await sql`CREATE INDEX due_hint_events_tenant_drain ON due_hint_events (tenant_id, drain, due)`.execute(db)
    await sql`CREATE INDEX due_hint_events_drain_tenant ON due_hint_events (drain, tenant_id)`.execute(db)

    await sql`
        CREATE FUNCTION sssb_note_due() RETURNS trigger
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = pg_catalog, pg_temp
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
            -- An append, with no key: it waits on no other transaction, and no other waits on it.
            INSERT INTO public.due_hint_events (tenant_id, drain, due)
            VALUES (NEW.tenant_id, TG_ARGV[0], COALESCE(due, '-infinity'::timestamptz));
            RETURN NULL;
        END
        $$
    `.execute(db)

    // Every grant on the new objects but the owner's goes: PUBLIC's defaults, and any an app migration's default
    // privileges gave (on an upgrade those ran first). REVOKE ALL on a table takes its column grants with it.
    await sql`
        DO $$
        DECLARE
            target regclass;
            holder oid;
        BEGIN
            FOREACH target IN ARRAY ARRAY['public.due_hints'::regclass, 'public.due_hint_events'::regclass] LOOP
                FOR holder IN
                    SELECT a.grantee FROM pg_class c, aclexplode(c.relacl) a
                    WHERE c.oid = target AND a.grantee <> c.relowner
                    UNION
                    SELECT a.grantee FROM pg_attribute att, aclexplode(att.attacl) a, pg_class c
                    WHERE att.attrelid = target AND c.oid = target AND a.grantee <> c.relowner
                LOOP
                    IF holder = 0 THEN
                        EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', target);
                    ELSE
                        EXECUTE format('REVOKE ALL ON %s FROM %I', target, pg_get_userbyid(holder));
                    END IF;
                END LOOP;
            END LOOP;
            REVOKE ALL ON FUNCTION public.sssb_note_due() FROM PUBLIC;
            FOR holder IN
                SELECT a.grantee FROM pg_proc p, aclexplode(p.proacl) a
                WHERE p.oid = 'public.sssb_note_due()'::regprocedure AND a.grantee NOT IN (0, p.proowner)
            LOOP
                EXECUTE format('REVOKE ALL ON FUNCTION public.sssb_note_due() FROM %I', pg_get_userbyid(holder));
            END LOOP;
            -- Whatever else lets app_user in (membership of the owning role itself), this migration does not finish.
            IF has_table_privilege('app_user', 'public.due_hints',
                    'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                OR has_any_column_privilege('app_user', 'public.due_hints', 'SELECT, INSERT, UPDATE, REFERENCES')
                OR has_table_privilege('app_user', 'public.due_hint_events',
                    'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                OR has_any_column_privilege('app_user', 'public.due_hint_events', 'SELECT, INSERT, UPDATE, REFERENCES')
                OR has_function_privilege('app_user', 'public.sssb_note_due()', 'EXECUTE') THEN
                RAISE EXCEPTION 'app_user can still reach the due hints after every grant was revoked: is it a member of the role that owns them?';
            END IF;
        END
        $$
    `.execute(db)

    // INSERT and UPDATE apart, so an update fires only when it can make work due SOONER: a row becoming eligible, or
    // its due time moving earlier.
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
    await sql`DROP TABLE due_hint_events`.execute(db)
    await sql`DROP TABLE due_hints`.execute(db)
}
