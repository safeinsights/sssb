import { auth, db } from '@sssb/kit/adapters/index'
import { authorize } from '@sssb/kit/authz/authorize'
import { recordAuditEvent } from '@sssb/kit/db/audit'
import { orgIdForSlug } from '@sssb/kit/db/org-lookup'
import { tenantIdForSlug } from '@sssb/kit/db/tenant-lookup'
import { deleteEndpoint, endpointForOrg, setEndpointEnabled } from '@sssb/kit/db/webhooks'
import type { AuthUser } from '@sssb/kit/ports/auth'
import { NotFoundError } from '@sssb/kit/ports/errors'
import { readJsonObject, requireUuidParam, withPortErrors } from '../../respond'

/**
 * Enable/disable (PATCH) or remove (DELETE) one of the active org's webhook endpoints — both
 * authorize()-gated (WebhookEndpoint update/delete = canManageOrg && sameOrg). Each authorizes FIRST,
 * against the active org, so a person who may not manage endpoints gets the same 403 whether or not the
 * id exists; only then must the endpoint belong to the active org (endpointForOrg → 404 otherwise: another
 * org's endpoint is indistinguishable from a missing one, the jobForOrg doctrine, safeinsights/sssb#137).
 * Deleting an endpoint cascades
 * its deliveries (migration 0010).
 */
async function activeOrg(user: AuthUser): Promise<{ tenantId: string; orgId: string }> {
    const tenantId = await tenantIdForSlug(db, user.tenantSlug)
    if (!tenantId) throw new NotFoundError('unknown tenant')
    const orgId = await orgIdForSlug(db, tenantId, user.orgSlug)
    if (!orgId) throw new NotFoundError('unknown org')
    return { tenantId, orgId }
}

/** The endpoint must be one of the active org's: a foreign or missing id is the same 404. */
async function requireEndpoint(tenantId: string, orgId: string, endpointId: string): Promise<void> {
    if (!(await endpointForOrg(db, tenantId, orgId, endpointId))) throw new NotFoundError('endpoint not found')
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    return withPortErrors(async () => {
        const user = await auth.requireUser()
        const { id } = await context.params
        requireUuidParam(id)
        const { enabled } = await readJsonObject(request)
        if (typeof enabled !== 'boolean') return Response.json({ error: 'invalid-request' }, { status: 400 })

        const { tenantId, orgId } = await activeOrg(user)
        authorize(user, orgId, 'update', { type: 'WebhookEndpoint', orgId })
        await requireEndpoint(tenantId, orgId, id)
        await setEndpointEnabled(db, tenantId, id, enabled)
        await recordAuditEvent(db, {
            tenantId,
            orgId,
            actorUserId: user.id,
            action: enabled ? 'webhook-endpoint.enabled' : 'webhook-endpoint.disabled',
            subjectType: 'WebhookEndpoint',
            subjectId: id,
        })
        return Response.json({ id, enabled })
    })
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    return withPortErrors(async () => {
        const user = await auth.requireUser()
        const { id } = await context.params
        requireUuidParam(id)

        const { tenantId, orgId } = await activeOrg(user)
        authorize(user, orgId, 'delete', { type: 'WebhookEndpoint', orgId })
        await requireEndpoint(tenantId, orgId, id)
        await deleteEndpoint(db, tenantId, id)
        await recordAuditEvent(db, {
            tenantId,
            orgId,
            actorUserId: user.id,
            action: 'webhook-endpoint.deleted',
            subjectType: 'WebhookEndpoint',
            subjectId: id,
        })
        return Response.json({ id })
    })
}
