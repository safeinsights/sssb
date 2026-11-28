import { setRequestLocale } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { auth, db } from '@sssb/kit/adapters/index'
import { authorize } from '@sssb/kit/authz/authorize'
import { LOCALES } from '@sssb/kit/core/locale'
import { listUserAcceptanceRecords } from '@sssb/kit/db/agreements'
import { tenantIdForSlug } from '@sssb/kit/db/tenant-lookup'
import { ProfileGlue } from './profile-glue'

export default async function ProfilePage({ params }: { params: Promise<{ locale: string }> }) {
    const { locale } = await params
    setRequestLocale(locale)
    const user = await auth.getCurrentUser()
    if (!user) redirect(`/${locale}${auth.signInPath()}`)
    // A read of the caller's own acceptances authorizes its self-only subject, as the accept route's create does.
    authorize(user, user.orgSlug, 'read', { type: 'AgreementAcceptance', ownerId: user.id })

    // Server-render the user's agreement acceptances (read-only list) — no client fetch needed. Empty
    // when the tenant lookup fails or nothing has been accepted; the section shows its own empty state.
    const tenantId = await tenantIdForSlug(db, user.tenantSlug)
    const acceptances = tenantId ? await listUserAcceptanceRecords(db, tenantId, user.id) : []

    return (
        <ProfileGlue
            initial={{ name: user.name, locale: user.locale }}
            email={user.email}
            locales={[...LOCALES]}
            locale={locale}
            acceptances={acceptances}
        />
    )
}
