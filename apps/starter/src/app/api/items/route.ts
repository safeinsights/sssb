import { auth, db } from '@sssb/kit/adapters/index'
import { authorize } from '@sssb/kit/authz/authorize'
import { clampKeysetLimit } from '@sssb/kit/core/keyset'
import { parseDbKeysetCursor } from '@sssb/kit/db/keyset'
import { orgIdForSlug } from '@sssb/kit/db/org-lookup'
import { tenantIdForSlug } from '@sssb/kit/db/tenant-lookup'
import { listItems } from '@/domain/db/items'
import { withPortErrors } from '../respond'

/**
 * The app's only product route. Items are tenant-scoped by RLS (the hostile-isolation boundary) AND
 * filtered to the active org (the team boundary — an app-level WHERE, since org membership is enforced
 * at the auth port; ADR-0004). Every query runs inside withTenant.
 *
 * GET lists ONE PAGE (`?cursor=<opaque>&limit=<n>`); both parameters are untrusted input. An unreadable
 * cursor is a 400, never a silent first page, and the page size is clamped on the server: the query
 * string may ask, it does not decide. A cursor carries no scope, since the tenant and the org are
 * resolved from the session on every page.
 */
export async function GET(request: Request): Promise<Response> {
    return withPortErrors(async () => {
        const user = await auth.requireUser()
        const params = new URL(request.url).searchParams
        const cursor = parseDbKeysetCursor(params.get('cursor'))
        if (cursor.kind === 'invalid') return Response.json({ error: 'invalid-cursor' }, { status: 400 })
        const tenantId = await tenantIdForSlug(db, user.tenantSlug)
        if (!tenantId) return Response.json({ error: 'unknown tenant' }, { status: 404 })
        const orgId = await orgIdForSlug(db, tenantId, user.orgSlug)
        if (!orgId) return Response.json({ error: 'unknown org' }, { status: 404 })
        // A read is authorized as a write is: being placed in an org is not membership of it (a signed-in person with
        // the role `none` has no standing there), so the session's org alone never decides what it may read.
        authorize(user, orgId, 'read', { type: 'Item', orgId })
        const { items, nextCursor } = await listItems(db, tenantId, orgId, {
            after: cursor.position ?? null,
            limit: clampKeysetLimit(params.get('limit')),
        })
        return Response.json({ items, nextCursor })
    })
}

export async function POST(request: Request): Promise<Response> {
    return withPortErrors(async () => {
        const user = await auth.requireUser()
        const { title } = (await request.json()) as { title: string }
        if (!title?.trim()) return Response.json({ error: 'empty item' }, { status: 400 })
        const tenantId = await tenantIdForSlug(db, user.tenantSlug)
        if (!tenantId) return Response.json({ error: 'unknown tenant' }, { status: 404 })
        const orgId = await orgIdForSlug(db, tenantId, user.orgSlug)
        if (!orgId) return Response.json({ error: 'unknown org' }, { status: 404 })
        // The authorization choke point: restricted members may read items but not author them.
        // Throws ForbiddenError → 403 via withPortErrors.
        authorize(user, orgId, 'create', { type: 'Item', orgId })
        const item = await db.withTenant(tenantId, (trx) =>
            trx
                .insertInto('items')
                .values({ tenant_id: tenantId, org_id: orgId, title: title.trim(), created_by_user_id: user.id })
                .returning(['id', 'title'])
                .executeTakeFirstOrThrow(),
        )
        return Response.json({ item })
    })
}
