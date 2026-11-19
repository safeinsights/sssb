import '@mantine/core/styles.css'
import '@/styles/index.css'

import { ColorSchemeScript, MantineProvider, mantineHtmlProps } from '@mantine/core'
import { hasLocale, NextIntlClientProvider } from 'next-intl'
import { setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { auth, isDemoMode, isSimulated } from '@sssb/kit/adapters/index'
import { DemoBadge } from '@sssb/kit/components/demo-badge'
import { routing } from '@sssb/kit/i18n/routing'
import { getTenantTheme } from '@sssb/kit/theme'
import { tenants } from '@/seed'

// The Simulator panel, in simulated mode only: the dynamic import keeps it, and everything behind it, out of a real
// build's client bundle. Its server side is `src/app/api/simulator/[...path]/route.ts`.
async function SimulatorChrome({ locale, children }: { locale: string; children: ReactNode }) {
    if (!isSimulated) return children
    const { SimulatorHost } = await import('@sssb/kit/components/simulator/simulator-host')
    return <SimulatorHost locale={locale}>{children}</SimulatorHost>
}

export const metadata = {
    title: 'Starter',
}

export function generateStaticParams() {
    return routing.locales.map((locale) => ({ locale }))
}

export default async function LocaleLayout({
    children,
    params,
}: {
    children: ReactNode
    params: Promise<{ locale: string }>
}) {
    const { locale } = await params
    if (!hasLocale(routing.locales, locale)) notFound()
    setRequestLocale(locale)

    // The theming seam (ADR-0005): the ACTIVE tenant drives the theme. Signed-out pages fall back to
    // this app's FIRST seeded tenant rather than SSSB's DEFAULT_TENANT_SLUG, which names the
    // world of SSSB's reference app — see the seam notes in SSSB's adoption guide.
    const user = await auth.getCurrentUser()
    const theme = getTenantTheme(user?.tenantSlug ?? tenants[0]!.slug)

    return (
        <html lang={locale} {...mantineHtmlProps}>
            <head>
                <ColorSchemeScript />
            </head>
            <body>
                <NextIntlClientProvider>
                    <MantineProvider theme={theme}>
                        <SimulatorChrome locale={locale}>{children}</SimulatorChrome>
                        {isDemoMode ? <DemoBadge /> : null}
                    </MantineProvider>
                </NextIntlClientProvider>
            </body>
        </html>
    )
}
