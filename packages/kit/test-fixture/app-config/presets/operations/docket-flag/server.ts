import { db } from '@sssb/kit/adapters/index'
import { recordAuditEvent } from '@sssb/kit/db/audit'
import { NotFoundError } from '@sssb/kit/ports/errors'
import { resolvePresetOrg, type ServerPresetOperationHandler } from '@sssb/kit/server-lib/preset-operations'
import { flagDocket } from '../../../../domain/dockets'
import type { DocketFlagArgs } from './definition'

/** The SERVER half of `docket.flag`: the docket the named result points at, in the named team, flagged and
 *  audited as `by`. A name that resolves to no docket in that team throws, like every unperformable step. */
export const docketFlagServer: ServerPresetOperationHandler<DocketFlagArgs> = async (args, ctx) => {
    const { tenantId, orgId } = await resolvePresetOrg(args.org)
    const docketId = ctx.refs.resolve(args.docket)
    if (!(await flagDocket(db, { tenantId, orgId, docketId }))) {
        throw new NotFoundError(`no docket "${args.docket}" in ${args.org}`)
    }
    await recordAuditEvent(db, {
        tenantId,
        orgId,
        actorUserId: args.by,
        action: 'docket.flagged',
        subjectType: 'Docket',
        subjectId: docketId,
    })
}
