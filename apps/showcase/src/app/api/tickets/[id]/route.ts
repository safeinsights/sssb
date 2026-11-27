import { auth, db } from '@sssb/kit/adapters/index'
import { authorize } from '@sssb/kit/authz/authorize'
import { recordAuditEvent } from '@sssb/kit/db/audit'
import { deleteTicket, ticketForOrg } from '@/domain/db/tickets'
import { applyTicketChanges, type TicketChanges } from '@/domain/ticket-changes'
import { isTicketStatus } from '@/domain/tickets'
import { resolveOrgContext } from '../../org-context'
import { readJsonObject, requireUuidParam, withPortErrors } from '../../respond'

/**
 * Editing and closing a ticket — the two routes the ability model has always described and nothing
 * could reach. `Ticket: update|delete` rules existed from the day the subject was registered, with no
 * HTTP surface behind them; an ability rule with no route is a rule nobody has ever exercised.
 *
 * PATCH changes status and/or assignee. DELETE removes the ticket (a real delete: the tickets table is
 * the one app table granted DELETE — see migration 1001). Both authorize FIRST, against the active org the
 * session resolves to (a ticket's org is the team's own), and only then look the row up ORG-SCOPED. So a
 * person who may not act gets the same 403 whether or not the id exists, and for one who may, a ticket
 * belonging to another team is indistinguishable from a missing one (404, the jobForOrg doctrine): no id can
 * be probed either way (safeinsights/sssb#137).
 *
 * PATCH is the boundary half of a ticket edit — parse, validate, resolve, authorize — and hands the edit
 * itself (write, audit verb, assignee notification) to `applyTicketChanges` (src/domain/ticket-changes.ts),
 * the same named operation the `ticket.assign` demo-preset step calls.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    return withPortErrors(async () => {
        const { id } = await context.params
        const user = await auth.requireUser()
        requireUuidParam(id)
        const payload = await readJsonObject(request)

        // Validate at the boundary, explicitly, before anything is resolved: an unknown status is a
        // 400, not a state machine surprise later.
        const changes: TicketChanges = {}
        if (payload.status !== undefined) {
            if (typeof payload.status !== 'string' || !isTicketStatus(payload.status)) {
                return Response.json({ error: 'unknown-status' }, { status: 400 })
            }
            changes.status = payload.status
        }
        if (payload.assigneeUserId !== undefined) {
            if (payload.assigneeUserId !== null && typeof payload.assigneeUserId !== 'string') {
                return Response.json({ error: 'invalid-assignee' }, { status: 400 })
            }
            changes.assigneeUserId = payload.assigneeUserId
        }
        if (changes.status === undefined && changes.assigneeUserId === undefined) {
            return Response.json({ error: 'nothing-to-change' }, { status: 400 })
        }

        const resolved = await resolveOrgContext(user)
        if (resolved instanceof Response) return resolved
        const { tenantId, orgId } = resolved

        // Authorization choke point, before the lookup: a restricted member may read the queue but not change
        // it, and is told so whether or not the id names a ticket.
        authorize(user, orgId, 'update', { type: 'Ticket', orgId })

        const before = await ticketForOrg(db, tenantId, orgId, id)
        if (!before) return Response.json({ error: 'not found' }, { status: 404 })

        // A ticket is handed to someone on this team, never to an id that names nobody (or someone
        // outside the org): checked against the auth port, the authority on membership, after the
        // caller is authorized so a denied caller learns nothing about who is a member.
        if (
            typeof changes.assigneeUserId === 'string' &&
            !(await auth.getMember(user.orgSlug, changes.assigneeUserId))
        ) {
            return Response.json({ error: 'invalid-assignee' }, { status: 400 })
        }

        // An illegal status hop (open → open, or anything the machine forbids) throws
        // InvalidTransitionError inside the transaction → 409 via withPortErrors, and no row is written.
        const ticket = await applyTicketChanges(db, {
            tenantId,
            orgId,
            orgSlug: user.orgSlug,
            ticket: before,
            changes,
            actor: { id: user.id, name: user.name },
        })
        if (!ticket) return Response.json({ error: 'not found' }, { status: 404 })
        return Response.json({ ticket })
    })
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    return withPortErrors(async () => {
        const { id } = await context.params
        const user = await auth.requireUser()
        requireUuidParam(id)
        const resolved = await resolveOrgContext(user)
        if (resolved instanceof Response) return resolved
        const { tenantId, orgId } = resolved

        authorize(user, orgId, 'delete', { type: 'Ticket', orgId })

        const ticket = await ticketForOrg(db, tenantId, orgId, id)
        if (!ticket) return Response.json({ error: 'not found' }, { status: 404 })

        const removed = await deleteTicket(db, tenantId, orgId, id)
        if (removed === 0) return Response.json({ error: 'not found' }, { status: 404 })
        // The audit event OUTLIVES the row — which is the whole reason the audit log is its own table.
        // Recorded after the delete commits, so it can only ever describe something that happened.
        await recordAuditEvent(db, {
            tenantId,
            orgId,
            actorUserId: user.id,
            action: 'ticket.deleted',
            subjectType: 'Ticket',
            subjectId: id,
        })
        return Response.json({ deleted: id })
    })
}
