import { auth, db, jobs, storage } from '@sssb/kit/adapters/index'
import { authorize } from '@sssb/kit/authz/authorize'
import { isJobKind } from '@sssb/kit/core/jobs'
import { recordAuditEvent } from '@sssb/kit/db/audit'
import { listJobs, submitJob } from '@sssb/kit/db/jobs'
import { resolveOrgContext } from '../org-context'
import { withPortErrors } from '../respond'

/**
 * Jobs are tenant-scoped by RLS AND filtered to the active org — the same two boundaries as the
 * tickets route (ADR-0004). GET returns the team's ten most recent jobs, each with its full
 * status timeline, plus a signed download URL for any completed job that produced a result. POST
 * submits a new job via the execution seam (fake: in-process; real: CodeBuild).
 */
export async function GET(): Promise<Response> {
    return withPortErrors(async () => {
        const user = await auth.requireUser()
        const resolved = await resolveOrgContext(user)
        if (resolved instanceof Response) return resolved
        const { tenantId, orgId } = resolved
        // A read is authorized as a write is: being placed in an org is not membership of it (a signed-in person
        // with the role `none` has no standing there), so the session's org alone never decides what it may read.
        authorize(user, orgId, 'read', { type: 'Job', orgId })
        const views = await listJobs(db, tenantId, orgId, { limit: 10 })
        // A completed job's result lives in storage; hand the browser a time-limited URL to fetch it.
        const withUrls = await Promise.all(
            views.map(async (job) => ({
                ...job,
                downloadUrl:
                    job.status === 'completed' && job.resultKey
                        ? await storage.getSignedDownloadUrl(job.resultKey)
                        : null,
            })),
        )
        return Response.json({ jobs: withUrls })
    })
}

export async function POST(request: Request): Promise<Response> {
    return withPortErrors(async () => {
        const user = await auth.requireUser()
        const { kind, payload } = (await request.json()) as { kind: string; payload?: unknown }
        if (!isJobKind(kind)) return Response.json({ error: 'unknown job kind' }, { status: 400 })
        // The payload is a jsonb blob the HANDLER interprets, so the route validates only its SHAPE
        // (a plain object) and leaves meaning to the handler — which must then treat it as untrusted
        // input, exactly as analyze-bundle does when it resolves the named attachment org-scoped.
        if (payload !== undefined && (typeof payload !== 'object' || payload === null || Array.isArray(payload))) {
            return Response.json({ error: 'invalid-payload' }, { status: 400 })
        }
        const resolved = await resolveOrgContext(user)
        if (resolved instanceof Response) return resolved
        const { tenantId, orgId } = resolved
        // Authorization choke point: restricted members may read jobs but not submit them.
        authorize(user, orgId, 'create', { type: 'Job', orgId })
        // The submitter is recorded, so the job's end reaches them when the org has no admin to tell.
        const { id } = await submitJob(db, jobs, {
            tenantId,
            orgId,
            kind,
            payload: payload ?? {},
            requestedBy: user.id,
        })
        // Audit trail: record the submission immediately after the authorized write.
        await recordAuditEvent(db, {
            tenantId,
            orgId,
            actorUserId: user.id,
            action: 'job.submitted',
            subjectType: 'Job',
            subjectId: id,
        })
        return Response.json({ id }, { status: 201 })
    })
}
