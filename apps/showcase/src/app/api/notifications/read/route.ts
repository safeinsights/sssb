import { auth, db } from '@sssb/kit/adapters/index'
import { authorize } from '@sssb/kit/authz/authorize'
import { markNotificationsRead } from '@sssb/kit/db/notifications'
import { resolveTenantId } from '../../org-context'
import { isUuid, withPortErrors } from '../../respond'

/**
 * Mark the caller's notifications read. authorize() with a self-only Notification subject is
 * the choke point; the mark query is ALSO recipient-scoped (WHERE recipient_user_id = the session user)
 * so a user can never mark another's rows even if the ability check were wrong — belt and braces. Body
 * `{ ids?: string[] }` narrows to specific rows; omitted = mark ALL the caller's unread (the bell marks
 * all on open — see the decision log). Returns how many rows flipped.
 */
export async function POST(request: Request): Promise<Response> {
    return withPortErrors(async () => {
        const user = await auth.requireUser()
        authorize(user, user.orgSlug, 'update', { type: 'Notification', ownerId: user.id })
        const tenantId = await resolveTenantId(user)
        if (tenantId instanceof Response) return tenantId
        // An absent or unreadable body marks everything read; a listed id that cannot be a row is a 400.
        const body: unknown = await request.json().catch(() => ({}))
        const listed = typeof body === 'object' && body !== null ? (body as { ids?: unknown }).ids : undefined
        if (Array.isArray(listed) && !listed.every(isUuid)) {
            return Response.json({ error: 'invalid-payload' }, { status: 400 })
        }
        const ids = Array.isArray(listed) ? listed : undefined
        const marked = await markNotificationsRead(db, tenantId, user.id, new Date(), ids)
        return Response.json({ marked })
    })
}
