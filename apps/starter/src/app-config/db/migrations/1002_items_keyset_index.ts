import { Kysely } from 'kysely'

/**
 * The index that makes the items list pageable (`@sssb/kit/db/keyset`).
 *
 * A keyset page reads `WHERE tenant_id = … AND org_id = … AND (created_at, id) < ($1, $2)
 * ORDER BY created_at DESC, id DESC LIMIT n`. Without a matching index that is a scan of the team's whole
 * list on EVERY page. The column order mirrors the query: the equality columns first (`tenant_id` is a
 * predicate RLS adds to every statement, so it belongs in the index), then the ordering pair in the
 * direction the walk reads it.
 *
 * A SEPARATE migration rather than an edit to 1001: an applied migration is a record, not a document to
 * revise, and an app that already ran 1001 must be able to take this one. A brand-new table meant to be
 * paged would carry its index in its own create migration instead.
 *
 * Not unique: two rows can share `(tenant_id, org_id, created_at)` (one transaction shares one `now()`),
 * which is why `id` is in the key at all.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
    await db.schema
        .createIndex('items_keyset_idx')
        .on('items')
        .columns(['tenant_id', 'org_id', 'created_at desc', 'id desc'])
        .execute()
}

export async function down(db: Kysely<unknown>): Promise<void> {
    await db.schema.dropIndex('items_keyset_idx').execute()
}
