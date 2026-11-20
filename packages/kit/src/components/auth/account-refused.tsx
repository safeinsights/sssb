'use client'

import { Alert, Button, Stack, Text } from '@mantine/core'
import { useTranslations } from 'next-intl'
import { useState } from 'react'

/**
 * The sign-in card's body for a person the identity provider has signed in but this app refuses
 * (`AuthPort.refusal`): their account names another tenant, or holds something that is not a tenant at all, so it is
 * taken to belong to another site. It says so, and offers one
 * explicit sign-out. Never automatic: on a provider instance shared with another product, signing out ends the
 * person's session there too, which the copy says before they choose.
 *
 * `onSignOut` answers whether the sign-out went through: `false` (or a rejection) shows the error and lets them try
 * again; anything else keeps the spinner while the page navigates (a reload, or the provider's own redirect).
 */
export function AccountRefused({ onSignOut }: { onSignOut: () => void | Promise<boolean | void> }) {
    const t = useTranslations('auth')
    const [busy, setBusy] = useState(false)
    const [failed, setFailed] = useState(false)

    async function signOut() {
        setBusy(true)
        setFailed(false)
        try {
            if ((await onSignOut()) === false) {
                setBusy(false)
                setFailed(true)
            }
        } catch {
            setBusy(false)
            setFailed(true)
        }
    }

    return (
        <Stack gap="sm" data-testid="account-refused">
            <Text fw={600}>{t('refusedTitle')}</Text>
            <Text size="sm">{t('refusedBody')}</Text>
            <Text size="sm" c="gray.7">
                {t('refusedSignOutNote')}
            </Text>
            {failed ? (
                <Alert color="red" role="alert">
                    {t('refusedSignOutError')}
                </Alert>
            ) : null}
            <Button onClick={() => void signOut()} loading={busy} data-testid="account-refused-signout">
                {t('signOut')}
            </Button>
        </Stack>
    )
}
