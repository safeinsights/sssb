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

afterEach(() => {
    vi.unstubAllEnvs()
    h.options = []
})

describe('withClerk', () => {
    test("hands Clerk's middleware the app's proxy as its handler, and answers with what the proxy answers", async () => {
        const event = { waitUntil: () => {} } as unknown as NextFetchEvent
        const request = new NextRequest('https://app.example.org/en/items')
        const answer = NextResponse.next()
        const appProxy = vi.fn(() => answer)
        const proxy = withClerk(appProxy)
        expect(await proxy(request, event)).toBe(answer)
        expect(appProxy).toHaveBeenCalledWith(request, event)
        expect(h.handlers).toBe(1)
    })

    test('passes CLERK_JWT_KEY on as jwtKey, which Clerk does not read from the environment itself', () => {
        vi.stubEnv('CLERK_JWT_KEY', '-----BEGIN PUBLIC KEY-----\nexample\n-----END PUBLIC KEY-----')
        withClerk(() => undefined)
        vi.stubEnv('CLERK_JWT_KEY', '')
        withClerk(() => undefined)
        expect(h.options).toEqual([{ jwtKey: '-----BEGIN PUBLIC KEY-----\nexample\n-----END PUBLIC KEY-----' }, {}])
    })
})
