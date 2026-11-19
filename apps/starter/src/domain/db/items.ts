import type { KeysetPosition } from '@sssb/kit/core/keyset'
import { keysetPage } from '@sssb/kit/db/keyset'
import type { DbPort } from '@sssb/kit/ports/db'

/** An item as its owning team sees it in the list. */
interface ItemView {
    id: string
    title: string
}

/** One page of a team's items, plus the token that fetches the next one (null at the end). */
export interface ItemPage {
    items: ItemView[]
    nextCursor: string | null
}

/**
 * Lists ONE PAGE of a team's items, newest first. Tenant-scoped by RLS AND filtered to the org: the same
 * two boundaries as every list (ADR-0004).
 *
 * A list that can grow pages through the framework primitive (`@sssb/kit/db/keyset`), never a hand-rolled
 * `LIMIT`/`OFFSET`. The callback is THE query, run once per page with the cursor added as one more
 * conjunct, so page 7 is scoped by construction: there is no second code path that could forget the org.
 * The order is fixed here (the primitive's default, `created_at` then `id`, newest first), never taken
 * from a request, because a cursor does not say which column it was minted under.
 */
export async function listItems(
    db: DbPort,
    tenantId: string,
    orgId: string,
    page: { after: KeysetPosition | null; limit: number },
): Promise<ItemPage> {
    const result = await keysetPage(db, { tenantId, after: page.after, limit: page.limit }, (trx) =>
        trx.selectFrom('items').select(['id', 'title']).where('org_id', '=', orgId),
    )
    return { items: result.rows.map(({ id, title }) => ({ id, title })), nextCursor: result.nextCursor }
}
