'use client'

import { useTranslations } from 'next-intl'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { useMemo } from 'react'
import { ActorsApp, type ActorSlot } from '@sssb/kit/components/simulator/actors-app'
import { SimulatorHost, useSimulatorWorld } from '@sssb/kit/components/simulator/simulator-host'
import type { SimulatorExtraTab } from '@sssb/kit/components/simulator/simulator-panel'
import { actors } from '@sssb/app-config/actors'
import { tabs as appSimulatorTabs } from '@sssb/app-config/simulator'

/**
 * This app's Simulator: SSSB's host (`@sssb/kit/components/simulator/simulator-host`, served by
 * `src/app/api/simulator/[...path]/route.ts`), plus the one part SSSB's host does not build, this app's own Actors tab
 * (safeinsights/sssb#152). Mounted from `src/app/[locale]/layout.tsx` in simulated mode only.
 *
 * The actor frames (`/[locale]/simulator/actors/<actor>`) render inside this same locale layout, but they are
 * self-contained process frames: the panel and its polling must not mount inside them (no nested Simulator, no poll
 * storm across every frame), so a pathname check renders just the page there.
 */
export function SimulatorGlue({ locale, children }: { locale: string; children: ReactNode }) {
    const pathname = usePathname()
    if (pathname?.includes('/simulator/actors/')) return <>{children}</>
    return <SimulatorWithActors locale={locale}>{children}</SimulatorWithActors>
}

function SimulatorWithActors({ locale, children }: { locale: string; children: ReactNode }) {
    const t = useTranslations('simulator')
    // The registered tabs (Actors today) slot into the panel between Hooks and Errors. Their content is this app's
    // (ADR-0006); Actors is the only one, so a second would branch on `tab.id` below.
    const extraTabs: SimulatorExtraTab[] = useMemo(
        () =>
            appSimulatorTabs.map((tab) => ({
                id: tab.id,
                label: t(tab.labelKey),
                keepMounted: tab.keepMounted,
                content: <ActorsTab locale={locale} />,
            })),
        [t, locale],
    )
    return (
        <SimulatorHost locale={locale} extraTabs={extraTabs}>
            {children}
        </SimulatorHost>
    )
}

/** The Actors tab: one frame per registered actor, and the world strip, from the jobs the host polls. */
function ActorsTab({ locale }: { locale: string }) {
    // The panel is handed finished strings: a counterparty this app invents is its own vocabulary, in its catalog's
    // `actors` namespace.
    const tActors = useTranslations('actors')
    const { jobs } = useSimulatorWorld()
    const slots: ActorSlot[] = useMemo(
        () =>
            actors.map((actor) => ({
                id: actor.id,
                title: tActors(actor.titleKey),
                description: tActors(actor.descriptionKey),
                // This app's own same-origin pages (src/app/[locale]/simulator/actors/[actor]); the suppression above
                // keeps the panel out of them.
                iframeSrc: `/${locale}/simulator/actors/${actor.id}`,
            })),
        [locale, tActors],
    )
    const counts = useMemo(
        () => ({
            queued: jobs.jobs.filter((job) => job.status === 'queued').length,
            running: jobs.jobs.filter((job) => job.status === 'running').length,
            completed: jobs.jobs.filter((job) => job.status === 'completed').length,
        }),
        [jobs.jobs],
    )
    return <ActorsApp slots={slots} world={{ held: jobs.held, counts }} />
}
