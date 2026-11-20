'use client'

import { AccountRefused } from '@sssb/kit/components/auth/account-refused'

/**
 * Client half of a refused sign-in: the person chose to sign out, so end their identity-provider session through the
 * app's sign-out route, then show the sign-in page again.
 */
export function RefusedGlue() {
    return (
        <AccountRefused
            onSignOut={() =>
                fetch('/api/auth/signout', { method: 'POST' }).then((response) => {
                    if (!response.ok) return false
                    window.location.reload()
                    return true
                })
            }
        />
    )
}
