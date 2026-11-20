'use client'

import { useAuth, useClerk } from '@clerk/nextjs'
import { AccountRefused } from '../../components/auth/account-refused'

/**
 * The refused-account screen in real mode (`@sssb/kit/components/auth/account-refused`), signing out through Clerk's
 * client. Revoking the session on the server alone leaves the browser's short-lived session token in place, which the
 * middleware still verifies until it lapses, so the page would reload onto the same screen. Clerk's client sign-out
 * ends this one session (`sessionId`) and clears its cookies, then the page reloads onto the sign-in form.
 *
 * Only on the person's click, as the screen says: on an identity-provider instance shared with another product, this
 * session may be that product's too. AUTHORED — CUTOVER (`auth-tenancy`): never run against a real Clerk instance.
 * Lives in packages/kit/src/adapters because it imports the vendor SDK; mount it under `RealAuthProviders`.
 */
export function RealAccountRefused() {
    const { signOut } = useClerk()
    const { sessionId } = useAuth()
    return (
        <AccountRefused
            onSignOut={async () => {
                await signOut(sessionId ? { sessionId } : undefined)
                window.location.reload()
                return true
            }}
        />
    )
}
