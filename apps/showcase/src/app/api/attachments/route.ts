import { auth, db, storage } from '@sssb/kit/adapters/index'
import { authorize } from '@sssb/kit/authz/authorize'
import { ATTACHMENT_MAX_BYTES, isAttachmentKind, sanitizeFilename } from '@/domain/attachments'
import { recordAuditEvent } from '@sssb/kit/db/audit'
import { createAttachment, listAttachments } from '@/domain/db/attachments'
import { resolveOrgContext } from '../org-context'
import { readJsonObject, withPortErrors } from '../respond'

/**
 * Typed attachments: browser-uploaded files, tenant-scoped by RLS AND filtered to the active
 * org — the same two boundaries as tickets/jobs (ADR-0004). GET lists the team's ready
 * attachments each with a signed download URL. POST is the MINT step of a two-step upload: it authorizes,
 * builds a SERVER-SIDE storage key, records a pending row, and hands back a presigned upload target the
 * browser sends the file to directly (a POST form or a PUT, whichever the store gives); POST /api/attachments/[id]/confirm then finalizes the row.
 */
export async function GET(): Promise<Response> {
    return withPortErrors(async () => {
        const user = await auth.requireUser()
        const resolved = await resolveOrgContext(user)
        if (resolved instanceof Response) return resolved
        const { tenantId, orgId } = resolved
        // A read is authorized as a write is: being placed in an org is not membership of it (a signed-in person
        // with the role `none` has no standing there), so the session's org alone never decides what it may read.
        authorize(user, orgId, 'read', { type: 'Attachment', orgId })

        const rows = await listAttachments(db, tenantId, orgId)
        // Each ready attachment's bytes live in storage; hand the browser a time-limited download URL.
        const attachments = await Promise.all(
            rows.map(async ({ storageKey, ...view }) => ({
                ...view,
                downloadUrl: await storage.getSignedDownloadUrl(storageKey),
            })),
        )
        return Response.json({ attachments })
    })
}

export async function POST(request: Request): Promise<Response> {
    return withPortErrors(async () => {
        const user = await auth.requireUser()
        const { filename, contentType, kind = 'attachment', sizeBytes } = await readJsonObject(request)
        if (typeof filename !== 'string' || !filename.trim()) {
            return Response.json({ error: 'missing-filename' }, { status: 400 })
        }
        if (contentType !== undefined && typeof contentType !== 'string') {
            return Response.json({ error: 'invalid-content-type' }, { status: 400 })
        }
        if (typeof kind !== 'string' || !isAttachmentKind(kind))
            return Response.json({ error: 'unknown-kind' }, { status: 400 })
        // The browser says how big the file is. A POST upload target holds the ceiling in its policy whatever the
        // client claims, but a PUT has none: it signs THIS size into the URL, so the store holds the upload to it
        // (and confirm re-checks what was stored). Refuse one that is not a size, or is over the ceiling, here, which
        // also avoids minting a doomed pending row.
        if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
            return Response.json({ error: 'invalid-size' }, { status: 400 })
        }
        if (sizeBytes > ATTACHMENT_MAX_BYTES) return Response.json({ error: 'too-large' }, { status: 400 })
        const type = contentType?.trim() || 'application/octet-stream'
        // Printable ASCII only: control chars (esp. newlines) would ambiguate the fake target's
        // canonical HMAC string and pollute the real S3 policy/Content-Type header.
        if (!/^[\x20-\x7e]{1,255}$/.test(type)) {
            return Response.json({ error: 'invalid-content-type' }, { status: 400 })
        }

        const resolved = await resolveOrgContext(user)
        if (resolved instanceof Response) return resolved
        const { tenantId, orgId } = resolved

        // Authorization choke point: restricted members may read attachments but not upload.
        authorize(user, orgId, 'create', { type: 'Attachment', orgId })

        // The storage key is built ENTIRELY server-side — tenant + a fresh uuid + the sanitized name —
        // so the client can never steer where bytes land (the resultKey prefix-lock lesson).
        const storageKey = `attachments/${tenantId}/${crypto.randomUUID()}/${sanitizeFilename(filename)}`
        const { id } = await createAttachment(db, {
            tenantId,
            orgId,
            kind,
            filename: filename.trim(),
            contentType: type,
            storageKey,
            uploadedByUserId: user.id,
        })
        const upload = await storage.createUploadTarget(storageKey, {
            contentType: type,
            maxBytes: ATTACHMENT_MAX_BYTES,
            sizeBytes,
        })
        // Audit trail: record the mint. The matching attachment.confirmed event lands when the
        // browser finalizes the upload — a minted-but-never-confirmed row leaves only this event, which
        // is exactly the honest record (someone started an upload that never completed).
        await recordAuditEvent(db, {
            tenantId,
            orgId,
            actorUserId: user.id,
            action: 'attachment.minted',
            subjectType: 'Attachment',
            subjectId: id,
        })
        return Response.json({ attachmentId: id, upload }, { status: 201 })
    })
}
