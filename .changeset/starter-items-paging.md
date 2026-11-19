---
'@sssb/create': patch
---

### The starter's items list pages, as the app guide requires

**Kind.** scaffold

**Action.** optional

**What changed.** The starter's `GET /api/items` returned every row, which broke the guide's rule that a list that can grow pages through `@sssb/kit/db/keyset` and made the example an adopter copies the wrong one. It now answers one page: it parses `?cursor=` with `parseDbKeysetCursor` and answers 400 `{ "error": "invalid-cursor" }` when it is `invalid`, clamps `?limit=` on the server, and orders by the primitive's fixed `created_at`, `id`, newest first. The response gains `nextCursor`. The query moves to `src/domain/db/items.ts` (`listItems`), migration `1002_items_keyset_index` adds the index the walk needs, the items card shows "Show older items" while a next page exists, and `src/app-config/db/rls-proofs.ts` proves a cursor from another team or tenant cannot widen a page.

**To adopt.** Nothing breaks if you do nothing; a route that never reads a cursor still works. To page a list of your own, copy the pattern: the route in `src/app/api/items/route.ts`, the query in `src/domain/db/items.ts`, the index migration (a separate migration for a table that already exists, or the index in the create migration for a new one), and the proofs at the end of `src/app-config/db/rls-proofs.ts`. The card and the dashboard glue show the "load more" side.

**Now deletable.** A hand-rolled `LIMIT`/`OFFSET` or an unbounded `.execute()` behind a list route.
