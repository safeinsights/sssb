import { Kysely, sql } from 'kysely'

/**
 * Lets a request WRITE `organizations` (create, rename, delete a team) inside its own tenant, and lets another table
 * pin its org to its own tenant in Postgres (safeinsights/sssb#124).
 *
 * Until now `app_user` held SELECT only (0003), so a route that created or renamed a team at request time failed with
 * `permission denied`. This grants INSERT, UPDATE (of the name) and DELETE, and puts the WRITES behind row-level
 * security:
 *
 * - READS stay cross-tenant, as before. `organizations` is read while resolving who is calling, before any tenant
 *   context exists (../org-lookup.ts), and a request joins another org of its own tenant (an escalation's responder),
 *   so the SELECT policy is `USING (true)`. That is what keeps it on the coverage check's exempt list
 *   (../rls-coverage.ts), whose entry for it now declares the three writes.
 * - WRITES are tenant-scoped, one policy per command: an INSERT or an UPDATE may only leave a row in the tenant the
 *   request runs in (`WITH CHECK`), and an UPDATE or a DELETE only reaches rows of that tenant (`USING`). With no tenant
 *   context the setting is NULL, every comparison is NULL, and no write lands: fail closed, as every tenant table.
 *   (The column grants below already keep `tenant_id` out of an UPDATE; the policy holds even if a later grant
 *   widens them.) WHICH person may write which team of their own tenant
 *   is an authorization decision (`authorize(...)`), not a grant one: a team is a collaboration boundary inside a
 *   tenant, the tenant the hostile-isolation boundary.
 * - ENABLE, not FORCE. FORCE would put the table's OWNER under these policies too, and the owner is the privileged
 *   path that seeds teams with no tenant context (../seed.ts). Its access is exactly what it was. An app's routes do
 *   not write as the owner: `getDb()` is banned in an app's `src` (`sssb/no-raw-db-handle`) bar the exceptions it
 *   names, and every `withTenant` switches to `app_user`. The kit's only writer of teams is that seed.
 * - A new team's slug may not be one another tenant's team holds. The inbound mail address names a team by its slug
 *   alone (`<org-slug>+<handler>@`, ../inbound-email.ts), resolved across every tenant and refused when two match, so
 *   a tenant that could take another's slug could silence that team's mail. Two tenants creating the same NEW slug at
 *   the same moment can both pass this check (it is not a constraint); their mail is then refused, never misfiled.
 *   A slug a team gives up by being deleted is free for any tenant to take, with whatever mail still comes to it.
 * - TRUNCATE is NOT granted: it ignores row-level security, so it would empty every tenant's teams.
 * - A DELETE succeeds only for a team nothing references: every table that names an org holds a plain foreign key
 *   to it, and the audit trail is append-only, so a team with history cannot be hard-deleted.
 *
 * `organizations_tenant_id_id_unique` over `(tenant_id, id)` is what a COMPOSITE foreign key needs: an app table
 * can then declare `FOREIGN KEY (tenant_id, org_id) REFERENCES organizations (tenant_id, id)`, and Postgres refuses a
 * row whose org belongs to another tenant. The id alone is the primary key, so the constraint never rejects a row
 * that the key accepts.
 *
 * It names the one table it touches (the order-independence rule in ./index.ts).
 */
export async function up(db: Kysely<any>): Promise<void> {
    await sql`ALTER TABLE organizations ADD CONSTRAINT organizations_tenant_id_id_unique UNIQUE (tenant_id, id)`.execute(
        db,
    )

    // Column grants: a request names a new team's tenant, slug and name (its id is the default), and renames it by
    // its name alone. The slug is how the auth provider and the inbound mail address name a team, and the id is what
    // every other table holds, so neither is a request's to change.
    await sql`GRANT INSERT (tenant_id, slug, name), UPDATE (name), DELETE ON organizations TO app_user`.execute(db)
    await sql`ALTER TABLE organizations ENABLE ROW LEVEL SECURITY`.execute(db)
    // NULLIF: unset tenant context must mean zero rows, never a cast error (the 1001_items pattern).
    await sql`CREATE POLICY organizations_read ON organizations FOR SELECT USING (true)`.execute(db)
    await sql`
        CREATE POLICY organizations_tenant_insert ON organizations
        FOR INSERT
        WITH CHECK (
            tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid
            AND NOT EXISTS (
                SELECT 1 FROM organizations other
                WHERE other.slug = organizations.slug AND other.tenant_id <> organizations.tenant_id
            )
        )
    `.execute(db)
    await sql`
        CREATE POLICY organizations_tenant_update ON organizations
        FOR UPDATE
        USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    `.execute(db)
    await sql`
        CREATE POLICY organizations_tenant_delete ON organizations
        FOR DELETE
        USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
    `.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
    await sql`DROP POLICY organizations_tenant_delete ON organizations`.execute(db)
    await sql`DROP POLICY organizations_tenant_update ON organizations`.execute(db)
    await sql`DROP POLICY organizations_tenant_insert ON organizations`.execute(db)
    await sql`DROP POLICY organizations_read ON organizations`.execute(db)
    await sql`REVOKE INSERT, UPDATE, DELETE ON organizations FROM app_user`.execute(db)
    await sql`ALTER TABLE organizations DISABLE ROW LEVEL SECURITY`.execute(db)
    await sql`ALTER TABLE organizations DROP CONSTRAINT organizations_tenant_id_id_unique`.execute(db)
}
