import type { Route } from 'next'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { auth, isSimulated } from '@sssb/kit/adapters/index'
import { listAllPeople } from '@sssb/kit/adapters/fake/auth'
import { SignInScreen } from '@sssb/kit/components/auth/sign-in-screen'
import { sameOriginPath } from '@sssb/kit/core/same-origin-path'
import { findTenant } from '@/seed'
import { PickerGlue } from './picker-glue'
import { RefusedGlue } from './refused-glue'

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
    // Only a path on this origin, normalised (a browser reads `/\\host` or `/<tab>/host` as another origin, which a
    // prefix check lets through); anything else falls back to the dashboard.
    const target = (sameOriginPath(returnTo) ?? `/${locale}/dashboard`) as Route

    if (await auth.getCurrentUser()) redirect(target)
    // Signed in to the identity provider but refused here (an account of another tenant): say why, and let the person
    // choose to sign out, rather than show a sign-in form they are already past.
    if (await auth.refusal?.()) return <SignInScreen body={<RefusedGlue />} />

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
