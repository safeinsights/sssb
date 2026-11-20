import type { Route } from 'next'
import { getTranslations, setRequestLocale } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { auth, isSimulated } from '@sssb/kit/adapters/index'
import { listAllPeople } from '@sssb/kit/adapters/fake/auth'
import { findTenant } from '@app/seed'
import { SignInScreen } from '@sssb/kit/components/auth/sign-in-screen'
import { sameOriginPath } from '@sssb/kit/core/same-origin-path'
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
    // Only a path on this origin, normalised (a prefix check lets `/\\host` through); else the dashboard.
    const target = sameOriginPath(returnTo) ?? `/${locale}/dashboard`

    const user = await auth.getCurrentUser()
    if (user) redirect(target as Route)
    // Signed in to the identity provider but refused here (an account of another tenant): say why, and let the person
    // choose to sign out, rather than show a sign-in form they are already past.
    if (await auth.refusal?.()) {
        // Real mode signs out through the provider's client, which also clears the session token the page would
        // otherwise still see; simulated mode through the app's sign-out route.
        if (isSimulated) return <SignInScreen body={<RefusedGlue />} />
        const { RealAccountRefused } = await import('@sssb/kit/adapters/real/account-refused-form')
        return <SignInScreen body={<RealAccountRefused />} />
    }

    let body
    if (isSimulated) {
        body = (
            <PickerGlue
                people={listAllPeople().map((p) => ({
                    id: p.id,
                    name: p.name,
                    role: p.memberships[0].role,
                    tenantName: findTenant(p.tenantSlug)?.name ?? p.tenantSlug,
                }))}
                returnTo={target}
            />
        )
    } else {
        const [{ RealSignInForm }, t] = await Promise.all([
            import('@sssb/kit/adapters/real/sign-in-form'),
            getTranslations('auth'),
        ])
        body = (
            <RealSignInForm
                returnTo={target}
                labels={{
                    email: t('emailLabel'),
                    password: t('passwordLabel'),
                    submit: t('signInButton'),
                    genericError: t('signInError'),
                    mfaNotImplemented: t('mfaNotImplemented'),
                }}
            />
        )
    }

    return <SignInScreen body={body} />
}
