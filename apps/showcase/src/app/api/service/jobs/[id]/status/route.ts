import { db } from '@sssb/kit/adapters/index'
import { authorize } from '@sssb/kit/authz/authorize'
import { exportKeyPrefix, isJobStatus } from '@sssb/kit/core/jobs'
import { jobForOrg, recordJobStatus } from '@sssb/kit/db/jobs'
import { readJsonObject, requireUuidParam } from '../../../../respond'
import { withServiceCaller } from '../../../respond'

const isOptionalString = (value: unknown): value is string | undefined =>
    value === undefined || typeof value === 'string'

/**
 * Service caller reports a status change for one of ITS OWN jobs. `queued` is rejected (a caller
 * never re-queues) as is any non-status string. Before the job is looked up, the caller is authorized as the
 * MACHINE it is (`update Job`, which, among machines, the framework grants only a service-key caller in its own
 * org), so a refusal does not depend on whether the id exists; then the job must belong to the caller's org, a
 * foreign org's job being indistinguishable from a missing one (404). The transition is validated by recordJobStatus's state machine; an illegal
 * hop surfaces as 409 via withServiceCaller.
 */
export const POST = withServiceCaller<{ id: string }>(async ({ identity, actor, request, params }) => {
    const id = requireUuidParam(params.id)
    const { status, resultKey, error, message } = await readJsonObject(request)
    if (typeof status !== 'string' || !isJobStatus(status) || status === 'queued') {
        return Response.json({ error: 'invalid-payload' }, { status: 400 })
    }
    if (!isOptionalString(resultKey) || !isOptionalString(error) || !isOptionalString(message)) {
        return Response.json({ error: 'invalid-payload' }, { status: 400 })
    }
    // A caller-supplied resultKey is later signed verbatim by GET /api/jobs, and storage isolation
    // is purely by key convention — so the key MUST stay inside the caller's own ORG namespace
    // (export keys encode tenant AND org for exactly this): a planted foreign key would otherwise
    // become a signed download of another org's — or tenant's — artifact.
    if (resultKey !== undefined && !resultKey.startsWith(exportKeyPrefix(identity.tenantId, identity.orgId))) {
        return Response.json({ error: 'invalid-payload' }, { status: 400 })
    }

    // Authorized before the lookup, on the caller's own org (jobForOrg matches a job ONLY within it, so that org is
    // the subject's): a caller who may not update jobs gets the same 403 whether or not the id names one
    // (safeinsights/sssb#137).
    authorize(actor, 'update', { type: 'Job', orgId: identity.orgId })
    const found = await jobForOrg(db, identity.tenantId, identity.orgId, id)
    if (!found) return Response.json({ error: 'not found' }, { status: 404 })

    await recordJobStatus(db, identity.tenantId, id, status, { resultKey, error, message })
    return Response.json({ ok: true })
})
