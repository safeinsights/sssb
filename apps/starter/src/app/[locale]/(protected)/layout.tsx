import { setRequestLocale } from 'next-intl/server'
import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { auth, isSimulated } from '@sssb/kit/adapters/index'
import { findTenant } from '@/seed'
import { HeaderGlue } from './header-glue'

/**
 * Everything in this group requires a signed-in user; signed-out visitors go to /signin.
 *
 * Deliberately shorter than SSSB's reference app's: no access-gate evaluation, because this app seeds no
 * agreements and registers no gates. The capability is not removed — it is simply unused, and an
 * unused capability needs no scaffolding (ADR-0012).
 */
export default async function ProtectedLayout({
    children,
    params,
}: {
    children: ReactNode
    params: Promise<{ locale: string }>
}) {
    const { locale } = await params
    setRequestLocale(locale)

    const user = await auth.getCurrentUser()
    if (!user) redirect(`/${locale}${auth.signInPath()}`)

    const orgs = await auth.listMyOrgs()
    const tenantName = findTenant(user.tenantSlug)?.name ?? user.tenantSlug
    const menuUser = { name: user.name, email: user.email }
    // Real mode signs out through the provider's client, which also clears the session token the next page would
    // otherwise still see; simulated mode through the app's sign-out route (the glue's own menu).
    let userMenu: ReactNode = null
    if (!isSimulated) {
        const { RealUserMenu } = await import('@sssb/kit/adapters/real/user-menu')
        userMenu = <RealUserMenu user={menuUser} signedOutHref={`/${locale}`} />
    }

    return (
        <>
            <HeaderGlue
                user={menuUser}
                userMenu={userMenu}
                orgs={orgs}
                activeSlug={user.orgSlug}
                tenantName={tenantName}
                locale={locale}
            />
            {children}
        </>
    )
}
