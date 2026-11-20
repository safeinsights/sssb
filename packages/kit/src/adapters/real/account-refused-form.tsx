'use client'

import { useAuth, useClerk } from '@clerk/nextjs'
import { AccountRefused } from '../../components/auth/account-refused'

/**
 * The refused-account screen in real mode (`@sssb/kit/components/auth/account-refused`), signing out through Clerk's
 * client. Revoking the session on the server alone leaves the browser's short-lived session token in place, which the
 * middleware still verifies until it lapses, so the page would come back refused. Clerk's client sign-out ends this one
 * session (`sessionId`), clears its cookies, and then sends the browser back to this page (`redirectUrl`), which now
 * shows the sign-in form.
 *
 * Only on the person's click, as the screen says: on an identity-provider instance shared with another product, this
 * session may be that product's too. Until Clerk has loaded and knows the session, a click signs nobody out and says
 * so: before then Clerk only queues the call, and with no session id it would end every session on the device.
 *
 * AUTHORED — CUTOVER (`auth-tenancy`): never run against a real Clerk instance. Lives in packages/kit/src/adapters
 * because it imports the vendor SDK; mount it under `RealAuthProviders`.
 */
export function RealAccountRefused() {
    const { signOut } = useClerk()
    const { isLoaded, sessionId } = useAuth()
    return (
        <AccountRefused
            onSignOut={async () => {
                if (!isLoaded || !sessionId) return false
                await signOut({ sessionId, redirectUrl: window.location.href })
                return true
            }}
        />
    )
}
