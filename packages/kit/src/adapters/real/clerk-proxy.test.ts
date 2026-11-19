import { generateKeyPairSync } from 'node:crypto'
import { NextRequest, NextResponse, type NextFetchEvent } from 'next/server'
import { afterEach, describe, expect, test, vi } from 'vitest'

// Clerk's middleware, faked after @clerk/nextjs 7.10 (`clerkMiddleware`, and `decorateRequest` with
// `setRequestHeadersOnNextResponse` in its server utils), with no network and no keys. It hands its handler the very
// request it was given, and then, only for a "next" or a same-origin rewrite, turns the answer into a rewrite and writes
// its own `x-clerk-auth-*` request headers onto it, building Next's override list from that request when the answer
// has none. A redirect, or a rewrite to another origin, it returns as it is. `h.handshake` makes it answer with its
// handshake redirect without calling the handler; `h.substitute` makes it hand the handler a different object.
const h = vi.hoisted(() => ({
    options: [] as unknown[],
    shown: [] as (string | null)[],
    handshake: false,
    substitute: false,
}))
vi.mock('@clerk/nextjs/server', async () => {
    const { NextRequest: Request, NextResponse: Response } = await import('next/server')
    return {
        clerkMiddleware: (
            handler: (auth: unknown, request: NextRequest, event: unknown) => Promise<Response | undefined>,
            options: unknown,
        ) => {
            h.options.push(options)
            return async (request: NextRequest, event: unknown) => {
                h.shown.push(request.headers.get('authorization'))
                if (h.handshake) return Response.redirect('https://clerk.example.org/v1/client/handshake')
                const handed = h.substitute ? new Request(request.url, { headers: request.headers }) : request
                const response = (await handler(() => null, handed, event)) ?? Response.next()
                if (response.headers.get('location')) return response
                let rewrite: URL | undefined
                if (response.headers.get('x-middleware-next') === '1') {
                    response.headers.delete('x-middleware-next')
                    rewrite = new URL(request.url)
                }
                const rewritten = response.headers.get('x-middleware-rewrite')
                if (rewritten) {
                    rewrite = new URL(rewritten)
                    if (rewrite.origin !== new URL(request.url).origin) return response
                }
                if (rewrite) {
                    if (!response.headers.get('x-middleware-override-headers')) {
                        response.headers.set('x-middleware-override-headers', [...request.headers.keys()].join(','))
                        request.headers.forEach((value, key) =>
                            response.headers.set(`x-middleware-request-${key}`, value),
                        )
                    }
                    for (const [key, value] of [
                        ['x-clerk-auth-status', 'signed-out'],
                        ['x-clerk-auth-token', ''],
                    ] as const) {
                        const listed = response.headers.get('x-middleware-override-headers')
                        response.headers.set('x-middleware-override-headers', `${listed},${key}`)
                        response.headers.set(`x-middleware-request-${key}`, value)
                    }
                    response.headers.set('x-middleware-rewrite', rewrite.href)
                }
                return response
            }
        },
    }
})

import { withClerk } from './clerk-proxy'

/**
 * The headers the route receives: Next's merge of a proxy's answer into the incoming request (`resolve-routes.js` in
 * Next 16.4): with an override list, exactly the listed headers, each from `x-middleware-request-<name>`; without one,
 * the request's own.
 */
function forwarded(request: NextRequest, response: Response | null | undefined | void): Headers {
    const listed = response?.headers.get('x-middleware-override-headers')
    if (!response || !listed) return new Headers(request.headers)
    const headers = new Headers()
    for (const key of new Set(listed.split(',').map((name) => name.trim()))) {
        const value = response.headers.get(`x-middleware-request-${key}`)
        if (value !== null) headers.set(key, value)
    }
    return headers
}

const event = { waitUntil: () => {} } as unknown as NextFetchEvent
function rsaPem(modulusLength: number) {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
        modulusLength,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    return { publicKey: publicKey.trim(), privateKey: privateKey.trim() }
}
const { publicKey: pem, privateKey } = rsaPem(2048)

function serviceCall(path = '/api/service/jobs') {
    return new NextRequest(`https://app.example.org${path}`, {
        method: 'POST',
        headers: { authorization: 'Bearer ak_x', 'x-clerk-auth-status': 'signed-in' },
        body: '{}',
    })
}

afterEach(() => {
    vi.unstubAllEnvs()
    h.options = []
    h.shown = []
    h.handshake = false
    h.substitute = false
})

describe('withClerk', () => {
    test("runs the app's proxy as Clerk's handler, on the request itself when it has no Authorization", async () => {
        const request = new NextRequest('https://app.example.org/en/items')
        const appProxy = vi.fn(() => NextResponse.next())
        const response = await withClerk(appProxy)(request, event)
        expect(appProxy).toHaveBeenCalledWith(request, event)
        expect(h.shown).toEqual([null])
        expect(forwarded(request, response).get('x-clerk-auth-status')).toBe('signed-out')
    })

    test.each([
        ['a next', () => NextResponse.next()],
        ['nothing', () => undefined],
        [
            'a next with its own list of request headers',
            (request: NextRequest) => NextResponse.next({ request: { headers: new Headers(request.headers) } }),
        ],
        ['a same-origin rewrite', () => NextResponse.rewrite('https://app.example.org/api/v2/jobs')],
    ])(
        "hides Authorization from Clerk and forwards it to the route, Clerk's auth headers over the client's, when the app's proxy answers %s",
        async (_shape, answer) => {
            const request = serviceCall()
            const appProxy = vi.fn(answer)
            const response = await withClerk(appProxy)(request, event)
            expect(h.shown).toEqual([null]) // Clerk read no token from the header
            expect(appProxy.mock.calls[0]?.[0]).toBe(request)
            const headers = forwarded(request, response)
            expect(headers.get('authorization')).toBe('Bearer ak_x')
            expect(headers.get('x-clerk-auth-status')).toBe('signed-out')
        },
    )

    test("forwards the request's own headers on a rewrite to another origin, which Clerk leaves alone", async () => {
        const request = serviceCall()
        const response = await withClerk(() => NextResponse.rewrite('https://elsewhere.example.org/jobs'))(
            request,
            event,
        )
        expect(response?.headers.get('x-middleware-override-headers')).toBeNull()
        expect(forwarded(request, response).get('authorization')).toBe('Bearer ak_x')
    })

    test("leaves out Authorization when the app's proxy left it out of its own list", async () => {
        const request = serviceCall()
        const response = await withClerk((original) => {
            const headers = new Headers(original.headers)
            headers.delete('authorization')
            return NextResponse.next({ request: { headers } })
        })(request, event)
        expect(forwarded(request, response).get('authorization')).toBeNull()
    })

    test.each([
        ["the app's proxy redirects", () => NextResponse.redirect('https://app.example.org/en/signin'), false],
        ['Clerk answers with its handshake redirect', () => NextResponse.next(), true],
    ])('answers with the redirect when %s', async (_case, answer, handshake) => {
        h.handshake = handshake
        const response = await withClerk(answer)(serviceCall(), event)
        expect(response?.headers.get('location')).toMatch(/^https:/)
        expect(response?.headers.get('x-middleware-override-headers')).toBeNull()
    })

    test('fails rather than hand the app a request it was not given', async () => {
        h.substitute = true
        await expect(withClerk(() => NextResponse.next())(serviceCall(), event)).rejects.toThrow(
            /handed its handler a request it was not given/,
        )
    })

    test('passes CLERK_JWT_KEY on as jwtKey, which Clerk does not read from the environment itself', () => {
        vi.stubEnv('CLERK_JWT_KEY', pem)
        withClerk(() => undefined)
        vi.stubEnv('CLERK_JWT_KEY', '')
        withClerk(() => undefined)
        expect(h.options).toEqual([{ jwtKey: pem }, {}])
    })

    test('reads a key held on one line with escaped newlines', () => {
        vi.stubEnv('CLERK_JWT_KEY', `  ${pem.replace(/\n/g, '\\n')}  `)
        withClerk(() => undefined)
        expect(h.options).toEqual([{ jwtKey: pem }])
    })

    test.each([
        ['not a key', 'not-a-key'],
        ['a private key', privateKey],
        ['a 4096-bit key', rsaPem(4096).publicKey],
    ])('refuses a CLERK_JWT_KEY that is %s, rather than signing everyone out', (_kind, value) => {
        vi.stubEnv('CLERK_JWT_KEY', value)
        expect(() => withClerk(() => undefined)).toThrow(/CLERK_JWT_KEY is not a 2048-bit RSA public key/)
    })
})
