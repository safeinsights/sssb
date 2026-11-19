import { createPublicKey } from 'node:crypto'
import { clerkMiddleware } from '@clerk/nextjs/server'
import type { NextFetchEvent, NextProxy, NextRequest } from 'next/server'

/**
 * Real mode's half of `withAuthProxy` (../proxy.ts): the app's proxy run inside Clerk's `clerkMiddleware`, which the
 * Clerk auth adapter (./auth.ts) needs. Clerk's `auth()` and `currentUser()` refuse to run in a request its middleware
 * did not see, in a page or an API route alike, so without this every real sign-in fails.
 *
 * It protects no route itself: each route's own `authorize()` does. Clerk reads `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
 * and `CLERK_SECRET_KEY` from the environment itself, the same ones the auth adapter needs. Clerk may answer a request
 * itself (its handshake redirect) without calling the app's proxy.
 *
 * Two kinds of request make Clerk's middleware call Clerk's API before the app's proxy runs, at a caller's choosing:
 * - A token in `Authorization`. Clerk accepts any kind of token there and verifies its machine tokens (`ak_`, `mt_`,
 *   `oat_`) through its API on every request. SSSB signs its users in by Clerk's session cookie and never sends a Clerk
 *   token in a header; its bearer tokens are its own (the webhook secret, service callers' JWTs), checked by the route.
 *   So a request with a header token skips Clerk (`hasHeaderToken`): the app's proxy runs alone, and a route that
 *   asked Clerk for its user would fail rather than answer.
 * - A session token (cookie or header) whose key id Clerk has not cached, which makes Clerk fetch its signing keys.
 *   `CLERK_JWT_KEY` stops that: Clerk does not read it from the environment, so it is passed on here as `jwtKey`, and
 *   Clerk then verifies every session token locally.
 */
export function withClerk(
    proxy: NextProxy,
): (request: NextRequest, event: NextFetchEvent) => Promise<Response | null | undefined | void> {
    const jwtKey = clerkJwtKey(process.env['CLERK_JWT_KEY'])
    const clerk = clerkMiddleware((_auth, request, event) => proxy(request, event), jwtKey ? { jwtKey } : {})
    return async (request, event) => (hasHeaderToken(request) ? proxy(request, event) : clerk(request, event))
}

/**
 * Whether Clerk would read a token from this request's `Authorization` header, by its own rule (`@clerk/backend`'s
 * `parseAuthorizationHeader`): the second word after `Bearer `, or the whole value when it is one word. Any other
 * scheme (`Basic …`) gives Clerk no token, and Clerk runs on the session cookie as usual.
 */
function hasHeaderToken(request: NextRequest): boolean {
    const header = request.headers.get('authorization')
    if (!header) return false
    const [scheme, token] = header.split(' ', 2)
    return !token || scheme === 'Bearer'
}

/**
 * The PEM public key, as a secret store or a one-line environment value often holds it (`\n` escapes, surrounding
 * space) made into the PEM Clerk parses; and refused at once if it is not a public key, since Clerk would otherwise
 * fail every session check with it and sign everyone out.
 */
function clerkJwtKey(value: string | undefined): string | undefined {
    const pem = value?.replace(/\\n/g, '\n').trim()
    if (!pem) return undefined
    try {
        createPublicKey(pem)
    } catch {
        throw new Error('CLERK_JWT_KEY is not a PEM public key: set it to the JWT public key from Clerk, or unset it')
    }
    return pem
}
