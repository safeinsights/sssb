'use client'

import { useTranslations } from 'next-intl'
import { AppHeader } from '@sssb/kit/components/app-header'
import { OrgSwitcher, type SwitcherOrg } from '@sssb/kit/components/auth/org-switcher'
import { UserMenu, type MenuUser } from '@sssb/kit/components/auth/user-menu'

/**
 * The framework header, wired to this app. Deliberately barer than SSSB's reference app's: no notification
 * bell (nothing here produces notifications) and no nav (there is one screen). `appName` is passed
 * because the prop is required: one shared framework catalog cannot name two products, so SSSB's
 * catalog carries no product name and every app supplies its own (see AppHeader).
 */
export function HeaderGlue({
    user,
    orgs,
    activeSlug,
    tenantName,
    locale,
}: {
    user: MenuUser
    orgs: SwitcherOrg[]
    activeSlug: string
    tenantName: string
    locale: string
}) {
    const t = useTranslations('welcome')
    return (
        <AppHeader
            appName={t('appName')}
            tenantName={tenantName}
            controls={
                <>
                    <OrgSwitcher
                        orgs={orgs}
                        activeSlug={activeSlug}
                        onSwitch={(orgSlug) => {
                            void fetch('/api/auth/org', {
                                method: 'POST',
                                headers: { 'content-type': 'application/json' },
                                body: JSON.stringify({ orgSlug }),
                            }).then((response) => {
                                if (response.ok) window.location.reload()
                            })
                        }}
                    />
                    <UserMenu
                        user={user}
                        onSignOut={() => {
                            void fetch('/api/auth/signout', {
                                method: 'POST',
                                headers: { 'content-type': 'application/json' },
                            }).then((response) => {
                                if (response.ok) window.location.assign(`/${locale}`)
                            })
                        }}
                    />
                </>
            }
        />
    )
}
