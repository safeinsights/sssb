import { auth, db } from '@sssb/kit/adapters/index'
import { authorize } from '@sssb/kit/authz/authorize'
import { recordAuditEvent } from '@sssb/kit/db/audit'
import { escalationForActiveOrg, transitionEscalation } from '@/domain/db/escalations'
import { enqueueWebhookEvent } from '@sssb/kit/db/webhooks'
import { ForbiddenError, NotFoundError } from '@sssb/kit/ports/errors'
import { resolveOrgContext } from '../../../org-context'
import { requireUuidParam, withPortErrors } from '../../../respond'

/**
 * The raising desk withdraws its own escalation. 'delete' is the authorization verb (only a
 * non-restricted member of the REQUESTER side may withdraw), but the DB does a SOFT transition to
 * 'cancelled' — there is no DELETE grant on escalations, so the row and its audit trail survive
 * (migration 0006). The request must have the active org as a side (else 404), and a person who may not
 * withdraw it gets that same 404, so no id can be probed: the authorize needs the row's real sides, so it
 * cannot come before the lookup, and its denial is answered as a missing row is. Withdrawing an
 * already-decided request surfaces as 409 via withPortErrors.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    return withPortErrors(async () => {
        const user = await auth.requireUser()
        const { id } = await context.params
        requireUuidParam(id)
        const resolved = await resolveOrgContext(user)
        if (resolved instanceof Response) return resolved
        const { tenantId, orgId: activeOrgId } = resolved

        const found = await escalationForActiveOrg(db, tenantId, activeOrgId, id)
        // A missing row and a refusal below are the one NotFoundError, so withPortErrors gives both one answer.
        if (!found) throw new NotFoundError()

        // The sides come from the row, so it is looked up first, and a person who may not act on it is told what a
        // missing id tells them: the same 404, status and body (safeinsights/sssb#137). The catch always rethrows,
        // so the denial still stops the handler.
        try {
            authorize(user, activeOrgId, 'delete', {
                type: 'Escalation',
                requesterOrgId: found.requesterOrgId,
                responderOrgId: found.responderOrgId,
            })
        } catch (error) {
            throw error instanceof ForbiddenError ? new NotFoundError() : error
        }

        await transitionEscalation(db, tenantId, id, 'cancelled', { byUserId: user.id })
        // Audit trail: recorded against the requester (active) side — the org that withdrew.
        await recordAuditEvent(db, {
            tenantId,
            orgId: activeOrgId,
            actorUserId: user.id,
            action: 'escalation.cancelled',
            subjectType: 'Escalation',
            subjectId: id,
        })
        // Outbound webhook: emit to the requester (active) org's endpoints — the org that withdrew.
        await enqueueWebhookEvent(db, {
            tenantId,
            orgId: activeOrgId,
            kind: 'escalation.decided',
            payload: {
                escalationId: id,
                decision: 'cancelled',
                requesterOrgId: found.requesterOrgId,
                responderOrgId: found.responderOrgId,
            },
        })
        return Response.json({ id, status: 'cancelled' })
    })
}
