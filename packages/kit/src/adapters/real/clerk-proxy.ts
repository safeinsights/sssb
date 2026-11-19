import { clerkMiddleware } from '@clerk/nextjs/server'
import type { NextFetchEvent, NextProxy, NextRequest } from 'next/server'

/**
 * Real mode's half of `withAuthProxy` (../proxy.ts): the app's proxy run inside Clerk's `clerkMiddleware`, which the
 * Clerk auth adapter (./auth.ts) needs. Clerk's `auth()` and `currentUser()` refuse to run in a request its middleware
 * did not see, in a page or an API route alike, so without this every real sign-in fails.
 *
 * It protects no route itself: each route's own `authorize()` does. Clerk reads its keys from the environment
 * (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and `CLERK_JWT_KEY` when set, with which it checks a
 * session without a network call), the same ones the auth adapter needs. Clerk may answer a request itself (its
 * handshake redirect) without calling the app's proxy.
 */
export function withClerk(
    proxy: NextProxy,
): (request: NextRequest, event: NextFetchEvent) => Promise<Response | null | undefined | void> {
    const clerk = clerkMiddleware((_auth, request, event) => proxy(request, event))
    return async (request, event) => clerk(request, event)
}
