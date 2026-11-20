import { auth, db } from '@sssb/kit/adapters/index'
import { authorize } from '@sssb/kit/authz/authorize'
import { clampKeysetLimit } from '@sssb/kit/core/keyset'
import { recordAuditEvent } from '@sssb/kit/db/audit'
import { parseDbKeysetCursor } from '@sssb/kit/db/keyset'
import { createTicket, listTickets } from '@/domain/db/tickets'
import { TICKET_PAGE_SIZE } from '@/domain/tickets'
import { resolveOrgContext } from '../org-context'
import { readJsonObject, withPortErrors } from '../respond'

/**
 * The desk's queue. Tickets are tenant-scoped by RLS (the hostile-isolation boundary) AND filtered to
 * the active org (the team collaboration boundary — an app-level WHERE, since org membership is
 * enforced at the auth port; ADR-0004). Every query still runs inside withTenant.
 *
 * GET lists ONE PAGE of the team's queue; POST opens a ticket. Editing and closing one live at
 * ./[id]/route.ts (PATCH/DELETE).
 */

/**
 * GET /api/tickets?cursor=<opaque>&limit=<n>
 *
 * Both parameters are UNTRUSTED INPUT and are treated as such, which is the whole reason paging is a
 * framework primitive rather than a per-list LIMIT:
 *
 *  - `cursor` is parsed by a total function that can only return start / after / invalid. An invalid
 *    one is a 400 rather than a silent first page, because a cursor the server cannot read means the
 *    client is confused and should hear about it. Nothing about the request's SCOPE comes from it —
 *    the tenant and the org are re-resolved from the session on every page below — so even a
 *    perfectly-crafted cursor (one minted in another tenant, say) can only narrow this caller's own
 *    rows, never reach another team's.
 *  - `limit` is clamped server-side. The query string may ASK; it does not decide.
 */
export async function GET(request: Request): Promise<Response> {
    return withPortErrors(async () => {
        const user = await auth.requireUser()
        const params = new URL(request.url).searchParams
        // Parsed before the org is resolved: an unreadable cursor is a client mistake, and it costs
        // nothing to say so without two database round trips first.
        const cursor = parseDbKeysetCursor(params.get('cursor'))
        if (cursor.kind === 'invalid') return Response.json({ error: 'invalid-cursor' }, { status: 400 })
        const resolved = await resolveOrgContext(user)
        if (resolved instanceof Response) return resolved
        const { tenantId, orgId } = resolved
        // A read is authorized as a write is: being placed in an org is not membership of it (a signed-in person
        // with the role `none` has no standing there), so the session's org alone never decides what it may read.
        authorize(user, orgId, 'read', { type: 'Ticket', orgId })
        const { tickets, nextCursor } = await listTickets(db, tenantId, orgId, {
            after: cursor.position ?? null,
            limit: clampKeysetLimit(params.get('limit'), TICKET_PAGE_SIZE),
        })
        return Response.json({ tickets, nextCursor })
    })
}

export async function POST(request: Request): Promise<Response> {
    return withPortErrors(async () => {
        const user = await auth.requireUser()
        const { subject, body } = await readJsonObject(request)
        if (typeof subject !== 'string' || !subject.trim()) {
            return Response.json({ error: 'missing-subject' }, { status: 400 })
        }
        if (body !== undefined && typeof body !== 'string')
            return Response.json({ error: 'invalid-payload' }, { status: 400 })
        const resolved = await resolveOrgContext(user)
        if (resolved instanceof Response) return resolved
        const { tenantId, orgId } = resolved
        // Authorization choke point: restricted members lose ticket-create even though they
        // can read the queue. Throws ForbiddenError → 403 via withPortErrors.
        authorize(user, orgId, 'create', { type: 'Ticket', orgId })
        const ticket = await createTicket(db, {
            tenantId,
            fallbackSlug: user.tenantSlug,
            orgId,
            subject: subject.trim(),
            body: body?.trim() ?? '',
        })
        // Audit trail: record the who/what/when immediately after the authorized write.
        await recordAuditEvent(db, {
            tenantId,
            orgId,
            actorUserId: user.id,
            action: 'ticket.created',
            subjectType: 'Ticket',
            subjectId: ticket.id,
        })
        return Response.json({ ticket }, { status: 201 })
    })
}
