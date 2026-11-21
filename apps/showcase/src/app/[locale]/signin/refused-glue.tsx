'use client'

import { AccountRefused } from '@sssb/kit/components/auth/account-refused'

/**
 * Client half of a refused sign-in in simulated mode: the person chose to sign out, so end their session through the
 * app's sign-out route, then show the sign-in page again. Real mode uses the provider's own client sign-out instead
 * (`@sssb/kit/adapters/real/account-refused-form`).
 */
export function RefusedGlue() {
    return (
        <AccountRefused
            onSignOut={() =>
                fetch('/api/auth/signout', { method: 'POST', headers: { 'content-type': 'application/json' } }).then(
                    (response) => {
                        if (!response.ok) return false
                        window.location.reload()
                        return true
                    },
                )
            }
        />
    )
}
