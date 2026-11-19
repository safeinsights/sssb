import { generateKeyPairSync } from 'node:crypto'
import { NextRequest, NextResponse, type NextFetchEvent } from 'next/server'
import { afterEach, describe, expect, test, vi } from 'vitest'

// Clerk's middleware, faked: it authenticates nothing (no network, no keys). Like Clerk's, it hands its handler the
// request it was given, and writes its own request headers onto the handler's answer, building Next's override list
// from that request when the answer has none (`setRequestHeadersOnNextResponse` in @clerk/nextjs). It records the
// options it was made with and the `Authorization` header of each request it was shown.
const h = vi.hoisted(() => ({ options: [] as unknown[], shown: [] as (string | null)[] }))
vi.mock('@clerk/nextjs/server', () => ({
    clerkMiddleware: (
        handler: (auth: unknown, request: NextRequest, event: unknown) => Promise<Response | undefined>,
        options: unknown,
    ) => {
        h.options.push(options)
        return async (request: NextRequest, event: unknown) => {
            h.shown.push(request.headers.get('authorization'))
            const response = (await handler(() => null, request, event)) ?? NextResponse.next()
            if (!response.headers.get('x-middleware-override-headers')) {
                response.headers.set('x-middleware-override-headers', [...request.headers.keys()].join(','))
                request.headers.forEach((value, key) => response.headers.set(`x-middleware-request-${key}`, value))
            }
            const listed = response.headers.get('x-middleware-override-headers')
            response.headers.set('x-middleware-override-headers', `${listed},x-clerk-auth-status`)
            response.headers.set('x-middleware-request-x-clerk-auth-status', 'signed-out')
            return response
        }
    },
}))

import { withClerk } from './clerk-proxy'

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

afterEach(() => {
    vi.unstubAllEnvs()
    h.options = []
    h.shown = []
})

describe('withClerk', () => {
    test("hands Clerk's middleware the app's proxy as its handler, and answers with what the proxy answers", async () => {
        const request = new NextRequest('https://app.example.org/en/items')
        const answer = NextResponse.next()
        const appProxy = vi.fn(() => answer)
        expect(await withClerk(appProxy)(request, event)).toBe(answer)
        expect(appProxy).toHaveBeenCalledWith(request, event)
        expect(h.shown).toEqual([null])
    })

    test.each(['Bearer ak_x', 'oat_x', 'Bearer eyJhbGciOiJSUzI1NiJ9.e30.x', 'Basic dTpw'])(
        'runs Clerk on a request bearing %s without showing it the header, which still reaches the proxy and the route',
        async (authorization) => {
            const request = new NextRequest('https://app.example.org/api/service/jobs', {
                method: 'POST',
                headers: { authorization, 'x-clerk-auth-status': 'signed-in' },
                body: '{}',
            })
            const appProxy = vi.fn<(request: NextRequest) => NextResponse>(() => NextResponse.next())
            const response = await withClerk(appProxy)(request, event)
            expect(h.shown).toEqual([null]) // Clerk ran, and read no token from the header
            expect(appProxy.mock.calls[0]?.[0]).toBe(request)
            expect(response?.headers.get('x-middleware-override-headers')?.split(',')).toContain('authorization')
            expect(response?.headers.get('x-middleware-request-authorization')).toBe(authorization)
            // Clerk's own answer, never the client's.
            expect(response?.headers.get('x-middleware-request-x-clerk-auth-status')).toBe('signed-out')
        },
    )

    test("leaves the override list alone when the app's proxy already built it from the request", async () => {
        const request = new NextRequest('https://app.example.org/en/items', { headers: { authorization: 'Bearer t' } })
        const response = await withClerk((original) =>
            NextResponse.next({ request: { headers: new Headers(original.headers) } }),
        )(request, event)
        const listed = response?.headers.get('x-middleware-override-headers')?.split(',') ?? []
        expect(listed.filter((name) => name === 'authorization')).toHaveLength(1)
        expect(response?.headers.get('x-middleware-request-authorization')).toBe('Bearer t')
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
