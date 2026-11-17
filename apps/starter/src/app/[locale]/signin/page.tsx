import type { Route } from 'next'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { auth, isSimulated } from '@sssb/kit/adapters/index'
import { listAllPeople } from '@sssb/kit/adapters/fake/auth'
import { SignInScreen } from '@sssb/kit/components/auth/sign-in-screen'
import { findTenant } from '@/seed'
import { PickerGlue } from './picker-glue'

export default async function SignInPage({
    params,
    searchParams,
}: {
    params: Promise<{ locale: string }>
    searchParams: Promise<{ returnTo?: string }>
}) {
    const { locale } = await params
    setRequestLocale(locale)
    const { returnTo } = await searchParams
    // Only same-origin, path-shaped targets; anything else falls back to the dashboard.
    const safe = returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//')
    const target = (safe ? returnTo : `/${locale}/dashboard`) as Route

    if (await auth.getCurrentUser()) redirect(target)

    if (!isSimulated) {
        const [{ RealSignInForm }, t] = await Promise.all([
            import('@sssb/kit/adapters/real/sign-in-form'),
            getTranslations('auth'),
        ])
        const labels = {
            email: t('emailLabel'),
            password: t('passwordLabel'),
            submit: t('signInButton'),
            genericError: t('signInError'),
            mfaNotImplemented: t('mfaNotImplemented'),
        }
        return <SignInScreen body={<RealSignInForm returnTo={target} labels={labels} />} />
    }

    // A person with no membership has no role to sign in as, so the picker leaves them out.
    const people = listAllPeople().flatMap((p) => {
        const membership = p.memberships[0]
        if (!membership) return []
        return [
            {
                id: p.id,
                name: p.name,
                role: membership.role,
                tenantName: findTenant(p.tenantSlug)?.name ?? p.tenantSlug,
            },
        ]
    })
    return <SignInScreen body={<PickerGlue people={people} returnTo={target} />} />
}
