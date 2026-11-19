import { NextRequest, NextResponse, type NextFetchEvent } from 'next/server'
import { describe, expect, test, vi } from 'vitest'

// Clerk's middleware, faked: it authenticates nothing (no network, no keys), and records that the app's proxy ran
// as its handler, with the request and the event Next gave it.
const h = vi.hoisted(() => ({ handlers: 0 }))
vi.mock('@clerk/nextjs/server', () => ({
    clerkMiddleware:
        (handler: (auth: unknown, request: unknown, event: unknown) => unknown) =>
        async (request: unknown, event: unknown) => {
            h.handlers += 1
            return handler(() => null, request, event)
        },
}))

import { withClerk } from './clerk-proxy'

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
})
