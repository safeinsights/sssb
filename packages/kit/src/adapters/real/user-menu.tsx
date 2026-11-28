'use client'

import { useAuth, useClerk } from '@clerk/nextjs'
import { UserMenu, type MenuUser } from '../../components/auth/user-menu'

/** The framework's sign-out route (`auth/signout`, exempted in ../../authz/route-policy.ts), which every app serves. */
const SIGN_OUT_ROUTE = '/api/auth/signout'

/**
 * The header's user menu in real mode (`@sssb/kit/components/auth/user-menu`), signing out through Clerk's client
 * (safeinsights/sssb#180). The sign-out route revokes the session on Clerk's server only: the browser keeps its
 * short-lived session token, which the middleware verifies locally until it lapses, so the page reached next could
 * still show the person signed in for up to a minute. Clerk's client sign-out ends this one session (`sessionId`),
 * clears its cookies, and then sends the browser to `signedOutHref` (`redirectUrl`), as ./account-refused-form.tsx does.
 *
 * Until Clerk has loaded and knows the session, or if its sign-out fails, it signs out through the sign-out route
 * instead, as simulated mode does: that revokes this session alone, by the id the server reads, where Clerk's client
 * with no session id would end every session on the device. The page reached then may lag as before.
 *
 * Its props are plain data, so a server layout can render it and hand it to a client header: `profileHref` is where
 * the menu's profile entry goes (none when omitted), `signedOutHref` where the browser lands signed out.
 *
 * AUTHORED — CUTOVER (`auth-dev`): never run against a real Clerk instance. Lives in packages/kit/src/adapters because
 * it imports the vendor SDK; mount it under `RealAuthProviders`.
 */
export function RealUserMenu({
    user,
    profileHref,
    signedOutHref,
}: {
    user: MenuUser
    profileHref?: string
    signedOutHref: string
}) {
    const { signOut } = useClerk()
    const { isLoaded, sessionId } = useAuth()

    async function signOutHere(): Promise<void> {
        if (isLoaded && sessionId) {
            try {
                await signOut({ sessionId, redirectUrl: signedOutHref })
                return
            } catch {
                // Clerk refused or could not be reached: the route below still revokes the session.
            }
        }
        const response = await fetch(SIGN_OUT_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
        })
        if (response.ok) window.location.assign(signedOutHref)
    }

    return (
        <UserMenu
            user={user}
            {...(profileHref !== undefined && { onProfile: () => window.location.assign(profileHref) })}
            onSignOut={() => void signOutHere()}
        />
    )
}
