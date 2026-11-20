'use client'

import { useCallback, useEffect, useState } from 'react'
import type { NotificationChannel, NotificationKind, NotificationPrefRow } from '@sssb/kit/core/notifications'
import { AcceptancesSection, type AcceptanceItem } from '@sssb/kit/components/agreements/acceptances-section'
import { ProfileScreen, type ProfileValues } from '@sssb/kit/components/profile-screen'
import { NotificationPrefsSection } from '@sssb/kit/components/notifications/notification-prefs-section'

export function ProfileGlue({
    initial,
    email,
    locales,
    locale,
    acceptances,
}: {
    initial: ProfileValues
    email: string
    locales: string[]
    locale: string
    acceptances: AcceptanceItem[]
}) {
    const [prefs, setPrefs] = useState<NotificationPrefRow[]>([])

    const refreshPrefs = useCallback(async () => {
        const response = await fetch('/api/notification-prefs')
        if (!response.ok) return
        const data = (await response.json()) as { prefs: NotificationPrefRow[] }
        setPrefs(data.prefs)
    }, [])

    useEffect(() => {
        // refreshPrefs sets state only after an awaited fetch — the "sync with an external system" case.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void refreshPrefs()
    }, [refreshPrefs])

    const onToggle = useCallback(
        async (kind: NotificationKind, channel: NotificationChannel, enabled: boolean) => {
            const response = await fetch('/api/notification-prefs', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ kind, channel, enabled }),
            })
            if (response.ok) await refreshPrefs()
        },
        [refreshPrefs],
    )

    return (
        <ProfileScreen
            initial={initial}
            email={email}
            locales={locales}
            onSave={async (values) => {
                const response = await fetch('/api/profile', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(values),
                })
                // A refusal (a name the auth adapter does not accept, say) rejects, so the screen keeps the form
                // and shows its error.
                if (!response.ok) throw new Error(`POST /api/profile answered ${response.status}`)
                if (values.locale !== locale) window.location.assign(`/${values.locale}/profile`)
            }}
            extraSection={
                <>
                    <NotificationPrefsSection prefs={prefs} onToggle={onToggle} />
                    <AcceptancesSection acceptances={acceptances} />
                </>
            }
        />
    )
}
