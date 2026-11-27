import { auth, db, storage } from '@sssb/kit/adapters/index'
import { authorize } from '@sssb/kit/authz/authorize'
import { recordAuditEvent } from '@sssb/kit/db/audit'
import { ATTACHMENT_MAX_BYTES } from '@/domain/attachments'
import { attachmentForOrg, confirmAttachment } from '@/domain/db/attachments'
import { resolveOrgContext } from '../../../org-context'
import { requireUuidParam, withPortErrors } from '../../../respond'

/**
 * The CONFIRM step of a two-step upload. After the browser has POSTed the file to the mint
 * step's upload target, it calls this to finalize the pending attachment row. We resolve the row
 * org-scoped (a foreign org's id is indistinguishable from a missing one — jobForOrg doctrine),
 * re-authorize the same create ability (finalizing one's own upload), then VERIFY the object actually
 * landed in storage, and is within the ceiling, before recording its true size and flipping status to ready.
 * Verifying here is what stops a caller minting + confirming without ever uploading, which would leave a dead
 * download link. The size is checked from `head` (the bytes are not read), because a PUT upload target holds the
 * ceiling only as far as the store honours the signed length (`StoragePort.createUploadTarget`): an object over
 * it is deleted and refused, never marked ready.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    return withPortErrors(async () => {
        const { id } = await context.params
        const user = await auth.requireUser()
        requireUuidParam(id)
        const resolved = await resolveOrgContext(user)
        if (resolved instanceof Response) return resolved
        const { tenantId, orgId } = resolved

        const attachment = await attachmentForOrg(db, tenantId, orgId, id)
        if (!attachment) return Response.json({ error: 'not found' }, { status: 404 })

        // Authorization choke point: only a non-restricted member of the owning org may
        // finalize an upload — the same ability that gated minting it.
        authorize(user, orgId, 'create', { type: 'Attachment', orgId })

        const stored = await storage.head(attachment.storageKey)
        if (!stored) return Response.json({ error: 'upload-missing' }, { status: 400 })
        if (stored.size > ATTACHMENT_MAX_BYTES) {
            await storage.delete([attachment.storageKey])
            return Response.json({ error: 'too-large' }, { status: 400 })
        }

        const updated = await confirmAttachment(db, tenantId, orgId, id, stored.size)
        if (updated === 0) {
            // Already ready: a re-confirm (double-click, retried request) is idempotent — and the
            // audit trail records only what actually happened, so NO second confirmed event.
            return Response.json({ attachmentId: id, idempotent: true }, { status: 200 })
        }
        // Audit trail: record the finalize immediately after the authorized write.
        await recordAuditEvent(db, {
            tenantId,
            orgId,
            actorUserId: user.id,
            action: 'attachment.confirmed',
            subjectType: 'Attachment',
            subjectId: id,
        })
        return Response.json({ attachmentId: id }, { status: 200 })
    })
}
