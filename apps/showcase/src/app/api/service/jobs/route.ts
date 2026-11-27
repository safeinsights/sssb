import { db } from '@sssb/kit/adapters/index'
import { authorize } from '@sssb/kit/authz/authorize'
import { isJobStatus, type JobStatus } from '@sssb/kit/core/jobs'
import { listServiceJobs } from '@sssb/kit/db/jobs'
import { withServiceCaller } from '../respond'

/**
 * Service-caller job poll: an org's jobs newest-first, no timelines (light polling). The caller's
 * org/tenant come from the verified identity — never from the request — so there is no org to pass.
 * The read is authorized as the MACHINE the caller is (`read Job` in its own org, which among machines
 * the framework grants only a service-key caller), as the status route authorizes its update.
 * Optional `?status=` narrows to one lifecycle state; an unknown value is a 400 invalid-payload.
 */
export const GET = withServiceCaller(async ({ identity, actor, request }) => {
    authorize(actor, 'read', { type: 'Job', orgId: identity.orgId })
    const raw = new URL(request.url).searchParams.get('status')
    let status: JobStatus | undefined
    if (raw !== null) {
        if (!isJobStatus(raw)) return Response.json({ error: 'invalid-payload' }, { status: 400 })
        status = raw
    }
    const jobs = await listServiceJobs(db, identity.tenantId, identity.orgId, { status })
    return Response.json({ jobs })
})
