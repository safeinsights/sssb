import { generateKeyPairSync } from 'node:crypto'
import { NextRequest, NextResponse, type NextFetchEvent } from 'next/server'
import { afterEach, describe, expect, test, vi } from 'vitest'

// Clerk's middleware, faked: it authenticates nothing (no network, no keys), and records the options it was made with
// and that the app's proxy ran as its handler, with the request and the event Next gave it.
const h = vi.hoisted(() => ({ handlers: 0, options: [] as unknown[] }))
vi.mock('@clerk/nextjs/server', () => ({
    clerkMiddleware: (handler: (auth: unknown, request: unknown, event: unknown) => unknown, options: unknown) => {
        h.options.push(options)
        return async (request: unknown, event: unknown) => {
            h.handlers += 1
            return handler(() => null, request, event)
        }
    },
}))

import { withClerk } from './clerk-proxy'

const event = { waitUntil: () => {} } as unknown as NextFetchEvent
const pem = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
}).publicKey.trim()

afterEach(() => {
    vi.unstubAllEnvs()
    h.options = []
    h.handlers = 0
})

describe('withClerk', () => {
    test("hands Clerk's middleware the app's proxy as its handler, and answers with what the proxy answers", async () => {
        const request = new NextRequest('https://app.example.org/en/items')
        const answer = NextResponse.next()
        const appProxy = vi.fn(() => answer)
        const proxy = withClerk(appProxy)
        expect(await proxy(request, event)).toBe(answer)
        expect(appProxy).toHaveBeenCalledWith(request, event)
        expect(h.handlers).toBe(1)
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

    test('refuses a CLERK_JWT_KEY that is not a public key, rather than signing everyone out', () => {
        vi.stubEnv('CLERK_JWT_KEY', 'not-a-key')
        expect(() => withClerk(() => undefined)).toThrow(/CLERK_JWT_KEY is not a PEM public key/)
    })

    test.each(['Bearer ak_x', 'oat_x', 'Bearer eyJhbGciOiJSUzI1NiJ9.e30.x'])(
        "skips Clerk's middleware for a request bearing %s, so Clerk makes no call for it",
        async (authorization) => {
            const appProxy = vi.fn(() => NextResponse.next())
            const request = new NextRequest('https://app.example.org/api/service/jobs', { headers: { authorization } })
            await withClerk(appProxy)(request, event)
            expect(appProxy).toHaveBeenCalledWith(request, event)
            expect(h.handlers).toBe(0)
        },
    )

    test("runs Clerk's middleware for another scheme, which gives Clerk no token", async () => {
        const request = new NextRequest('https://app.example.org/en/items', {
            headers: { authorization: 'Basic dTpw' },
        })
        await withClerk(() => NextResponse.next())(request, event)
        expect(h.handlers).toBe(1)
    })
})
