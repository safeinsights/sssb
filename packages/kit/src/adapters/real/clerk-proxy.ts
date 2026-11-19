import { createPublicKey } from 'node:crypto'
import { clerkMiddleware } from '@clerk/nextjs/server'
import { NextRequest, type NextFetchEvent, type NextProxy } from 'next/server'

/**
 * Real mode's half of `withAuthProxy` (../proxy.ts): the app's proxy run inside Clerk's `clerkMiddleware`, which the
 * Clerk auth adapter (./auth.ts) needs. Clerk's `auth()` and `currentUser()` refuse to run in a request its middleware
 * did not see, in a page or an API route alike, so without this every real sign-in fails. Clerk runs on every request
 * the proxy sees, and always writes its own `x-clerk-auth-*` request headers over any a client sent.
 *
 * It protects no route itself: each route's own `authorize()` does. Clerk reads `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
 * and `CLERK_SECRET_KEY` from the environment itself, the same ones the auth adapter needs. Clerk may answer a request
 * itself (its handshake redirect) without calling the app's proxy.
 *
 * Two kinds of request would make Clerk's middleware call Clerk's API before the app's proxy runs, at a caller's
 * choosing:
 * - A token in `Authorization`. Clerk accepts any kind of token there and verifies its machine tokens (`ak_`, `mt_`,
 *   `oat_`) through its API on every request. SSSB signs its users in by Clerk's session cookie and never sends a Clerk
 *   token in a header; its bearer tokens are its own (the webhook secret, service callers' JWTs), checked by the route.
 *   So Clerk is shown the request without its `Authorization` header (`withoutAuthorization`), and the app's proxy and
 *   the route still get it (`keepAuthorization`).
 * - A session token whose key id Clerk has not cached, which makes Clerk fetch its signing keys. `CLERK_JWT_KEY` stops
 *   that: Clerk does not read it from the environment, so it is passed on here as `jwtKey`, and Clerk then verifies
 *   every session token locally.
 */
export function withClerk(
    proxy: NextProxy,
): (request: NextRequest, event: NextFetchEvent) => Promise<Response | null | undefined | void> {
    const jwtKey = clerkJwtKey(process.env['CLERK_JWT_KEY'])
    // Clerk hands its handler the request it was given, the copy: the app's proxy gets the original.
    const originals = new WeakMap<NextRequest, NextRequest>()
    const clerk = clerkMiddleware(
        (_auth, request, event) => proxy(originals.get(request) ?? request, event),
        jwtKey ? { jwtKey } : {},
    )
    return async (request, event) => {
        const authorization = request.headers.get('authorization')
        if (authorization === null) return clerk(request, event)
        const copy = withoutAuthorization(request)
        originals.set(copy, request)
        return keepAuthorization(await clerk(copy, event), authorization)
    }
}

/** The request as Clerk is shown it: no `Authorization` header, and no body, which Clerk never reads. */
function withoutAuthorization(request: NextRequest): NextRequest {
    const headers = new Headers(request.headers)
    headers.delete('authorization')
    return new NextRequest(request.url, { method: request.method, headers })
}

const OVERRIDE = 'x-middleware-override-headers'

/**
 * Next forwards a request with the headers a proxy's response lists in `x-middleware-override-headers` (each value in
 * `x-middleware-request-<name>`), when there is that list. Clerk builds it from the request it was shown when the app's
 * proxy did not, which would drop `Authorization` on its way to the route: put it back.
 */
function keepAuthorization<T extends Response | null | undefined | void>(response: T, authorization: string): T {
    const listed = response?.headers.get(OVERRIDE)
    if (response && listed && !listed.split(',').includes('authorization')) {
        response.headers.set(OVERRIDE, `${listed},authorization`)
        response.headers.set('x-middleware-request-authorization', authorization)
    }
    return response
}

/**
 * The PEM public key, as a secret store or a one-line environment value often holds it (`\n` escapes, surrounding
 * space) made into the PEM Clerk parses; and refused at once if it is not the kind Clerk can read (a 2048-bit RSA
 * public key in SPKI PEM, whose fixed prefix Clerk strips as text), since Clerk would otherwise fail every session check
 * with it and sign everyone out.
 */
function clerkJwtKey(value: string | undefined): string | undefined {
    const pem = value?.replace(/\\n/g, '\n').trim()
    if (!pem) return undefined
    if (!isClerkReadableKey(pem)) {
        throw new Error(
            'CLERK_JWT_KEY is not a 2048-bit RSA public key in PEM: set it to the JWT public key from Clerk, or unset it',
        )
    }
    return pem
}

function isClerkReadableKey(pem: string): boolean {
    try {
        const key = createPublicKey(pem)
        return (
            pem.startsWith('-----BEGIN PUBLIC KEY-----') &&
            key.asymmetricKeyType === 'rsa' &&
            key.asymmetricKeyDetails?.modulusLength === 2048
        )
    } catch {
        return false
    }
}
