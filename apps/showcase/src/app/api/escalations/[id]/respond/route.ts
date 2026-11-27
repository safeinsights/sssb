import { auth, db } from '@sssb/kit/adapters/index'
import { authorize } from '@sssb/kit/authz/authorize'
import { recordAuditEvent } from '@sssb/kit/db/audit'
import { escalationForActiveOrg, transitionEscalation } from '@/domain/db/escalations'
import { enqueueWebhookEvent } from '@sssb/kit/db/webhooks'
import { ForbiddenError, NotFoundError } from '@sssb/kit/ports/errors'
import { resolveOrgContext } from '../../../org-context'
import { readJsonObject, requireUuidParam, withPortErrors } from '../../../respond'

/**
 * The receiving team decides an escalation (accept/reject). The request must have the active org
 * as one of its two sides — a foreign request is indistinguishable from a missing one (404, the jobForOrg
 * doctrine). Only an org MANAGER on the RESPONDER side may respond (authorize with the row's REAL org ids,
 * so after the lookup), and anyone else gets that same 404, so no id can be probed. The transition is validated by the state machine; deciding
 * an already-decided request (double-accept, accept-after-cancel) surfaces as 409 via withPortErrors.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    return withPortErrors(async () => {
        const user = await auth.requireUser()
        const { id } = await context.params
        requireUuidParam(id)
        const { decision } = await readJsonObject(request)
        if (decision !== 'accept' && decision !== 'reject') {
            return Response.json({ error: 'invalid-decision' }, { status: 400 })
        }
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
            authorize(user, activeOrgId, 'update', {
                type: 'Escalation',
                requesterOrgId: found.requesterOrgId,
                responderOrgId: found.responderOrgId,
            })
        } catch (error) {
            throw error instanceof ForbiddenError ? new NotFoundError() : error
        }

        const next = decision === 'accept' ? 'accepted' : 'rejected'
        await transitionEscalation(db, tenantId, id, next, { byUserId: user.id })
        // Audit trail: recorded against the responder (active) side — the org that decided.
        await recordAuditEvent(db, {
            tenantId,
            orgId: activeOrgId,
            actorUserId: user.id,
            action: decision === 'accept' ? 'escalation.accepted' : 'escalation.rejected',
            subjectType: 'Escalation',
            subjectId: id,
        })
        // Outbound webhook: emit to the responder (active) org's endpoints — the org that decided.
        await enqueueWebhookEvent(db, {
            tenantId,
            orgId: activeOrgId,
            kind: 'escalation.decided',
            payload: {
                escalationId: id,
                decision: next,
                requesterOrgId: found.requesterOrgId,
                responderOrgId: found.responderOrgId,
            },
        })
        return Response.json({ id, status: next })
    })
}
