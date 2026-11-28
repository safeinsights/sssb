import { findOrg } from '@app/seed'
import { setRequestLocale } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { auth } from '@sssb/kit/adapters/index'
import { authorize } from '@sssb/kit/authz/authorize'
import { canManageOrg, ORG_ASSIGNABLE_ROLES } from '@sssb/kit/core/roles'
import { OrgGlue } from './org-glue'

export default async function OrgPage({ params }: { params: Promise<{ locale: string }> }) {
    const { locale } = await params
    setRequestLocale(locale)
    const user = await auth.getCurrentUser()
    if (!user) redirect(`/${locale}${auth.signInPath()}`)
    // The member list is org-scoped data: a person placed in the org without standing (the role `none`) may not read
    // it. Keyed by the active org's slug, so the slug anchors both sides, as the invite route's Membership check does.
    authorize(user, user.orgSlug, 'read', { type: 'Membership', orgId: user.orgSlug })

    const members = await auth.listMembers(user.orgSlug)
    const orgName = findOrg(user.orgSlug)?.name ?? user.orgSlug

    return (
        <OrgGlue
            orgName={orgName}
            members={members}
            roles={[...ORG_ASSIGNABLE_ROLES]}
            canManage={canManageOrg(user.role)}
        />
    )
}
