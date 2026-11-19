import { clerkMiddleware } from '@clerk/nextjs/server'
import type { NextFetchEvent, NextProxy, NextRequest } from 'next/server'

/**
 * Real mode's half of `withAuthProxy` (../proxy.ts): the app's proxy run inside Clerk's `clerkMiddleware`, which the
 * Clerk auth adapter (./auth.ts) needs. Clerk's `auth()` and `currentUser()` refuse to run in a request its middleware
 * did not see, in a page or an API route alike, so without this every real sign-in fails.
 *
 * It protects no route itself: each route's own `authorize()` does. Clerk reads `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
 * and `CLERK_SECRET_KEY` from the environment itself, the same ones the auth adapter needs. It does NOT read
 * `CLERK_JWT_KEY`, so this passes it on as `jwtKey` when it is set: with it, Clerk verifies a session token locally;
 * without it, a request bearing a JWT whose key id Clerk has not cached (any JWT in an `Authorization` header, a
 * service caller's included) makes Clerk fetch its signing keys from Clerk's API before the app's proxy runs. Clerk
 * may answer a request itself (its handshake redirect) without calling the app's proxy.
 */
export function withClerk(
    proxy: NextProxy,
): (request: NextRequest, event: NextFetchEvent) => Promise<Response | null | undefined | void> {
    const jwtKey = process.env['CLERK_JWT_KEY']
    const clerk = clerkMiddleware((_auth, request, event) => proxy(request, event), jwtKey ? { jwtKey } : {})
    return async (request, event) => clerk(request, event)
}
