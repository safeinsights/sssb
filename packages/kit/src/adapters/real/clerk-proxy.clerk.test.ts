// @vitest-environment node
import { createSign, generateKeyPairSync } from 'node:crypto'
import { NextRequest, NextResponse, type NextFetchEvent } from 'next/server'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

/**
 * `withClerk` (./clerk-proxy.ts) around Clerk's REAL middleware (@clerk/nextjs 7.10, and the `authenticateRequest` of
 * the @clerk/backend it installs), offline: session tokens are signed here with a key generated for the test and
 * verified by Clerk against `CLERK_JWT_KEY`, so no request leaves the process (`fetch` fails the test if one tries).
 * What the route is told is what Clerk writes for it (`x-clerk-auth-status` and `x-clerk-auth-reason`), as Next would
 * forward them. ./clerk-proxy.test.ts covers the rest of `withClerk` with Clerk faked.
 */

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey

const APP = 'https://app.example.org'
const OTHER = 'https://other-product.example.org'

function base64url(value: string | Buffer): string {
    return Buffer.from(value).toString('base64url')
}

/** A Clerk session token as Clerk's Frontend API mints it, signed with `key`, with `azp` when given. */
function sessionToken(azp: string | undefined, key: Parameters<ReturnType<typeof createSign>['sign']>[0] = privateKey) {
    const now = Math.floor(Date.now() / 1000)
    // `cat` is the category Clerk gives a session token (@clerk/backend's JWT_CATEGORY_SESSION_TOKEN): without it Clerk
    // reads the token as some other kind and signs the request out.
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'ins_test', cat: 'cl_B7d4PD111AAA' }))
    const payload = base64url(
        JSON.stringify({
            sub: 'user_test',
            sid: 'sess_test',
            iss: 'https://clerk.example.org',
            iat: now - 5,
            nbf: now - 5,
            exp: now + 60,
            ...(azp !== undefined && { azp }),
        }),
    )
    const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key)
    return { token: `${header}.${payload}.${base64url(signature)}`, iat: now - 5 }
}

/** A signed-in request to the app: the session cookie, and the client cookie Clerk pairs it with. */
function signedInRequest(token: { token: string; iat: number }) {
    return new NextRequest(`${APP}/api/items`, {
        headers: { cookie: `__session=${token.token}; __client_uat=${token.iat}` },
    })
}

const event = { waitUntil: () => {} } as unknown as NextFetchEvent
const fetchSpy = vi.fn(() => Promise.reject(new Error('Clerk tried to reach the network')))

/** What Clerk tells the route about the request, read from the request headers it forwards. */
async function routeIsTold(request: NextRequest) {
    const { withClerk } = await import('./clerk-proxy')
    const response = await withClerk(() => NextResponse.next())(request, event)
    return {
        status: response?.headers.get('x-middleware-request-x-clerk-auth-status'),
        reason: response?.headers.get('x-middleware-request-x-clerk-auth-reason') || null,
    }
}

beforeAll(() => {
    // Clerk reads its keys from the environment when its modules load, so they are set before the first import.
    // A production publishable key: a development instance would want its dev-browser cookie as well.
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', `pk_live_${Buffer.from('clerk.example.org$').toString('base64')}`)
    vi.stubEnv('CLERK_SECRET_KEY', 'sk_live_test')
    vi.stubEnv('CLERK_JWT_KEY', publicKey)
    vi.stubEnv('CLERK_AUTHORIZED_PARTIES', undefined)
    vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
    vi.stubEnv('CLERK_AUTHORIZED_PARTIES', undefined)
    expect(fetchSpy).not.toHaveBeenCalled()
})

afterAll(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
})

describe("withClerk around Clerk's own middleware", () => {
    test('signs in a session token Clerk can verify, and signs out one it cannot (the check is real)', async () => {
        expect(await routeIsTold(signedInRequest(sessionToken(APP)))).toEqual({ status: 'signed-in', reason: null })
        const forged = await routeIsTold(signedInRequest(sessionToken(APP, otherKey)))
        expect(forged).toMatchObject({ status: 'signed-out', reason: 'token-invalid-signature' })
    })

    test('with CLERK_AUTHORIZED_PARTIES unset, accepts a token for any origin, or naming none, as before', async () => {
        for (const azp of [APP, OTHER, undefined]) {
            expect(await routeIsTold(signedInRequest(sessionToken(azp)))).toEqual({
                status: 'signed-in',
                reason: null,
            })
        }
    })

    test('with CLERK_AUTHORIZED_PARTIES set, accepts a token for a listed origin', async () => {
        vi.stubEnv('CLERK_AUTHORIZED_PARTIES', `${OTHER}, ${APP}`)
        expect(await routeIsTold(signedInRequest(sessionToken(APP)))).toEqual({ status: 'signed-in', reason: null })
    })

    test.each([
        ['another origin', OTHER],
        ['no origin at all', undefined],
        ['the listed origin with a trailing slash', `${APP}/`],
    ])('with CLERK_AUTHORIZED_PARTIES set, signs out a token for %s', async (_case, azp) => {
        vi.stubEnv('CLERK_AUTHORIZED_PARTIES', APP)
        expect(await routeIsTold(signedInRequest(sessionToken(azp)))).toEqual({
            status: 'signed-out',
            reason: 'token-invalid-authorized-parties',
        })
    })
})
