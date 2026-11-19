import { NextRequest, NextResponse, type NextFetchEvent } from 'next/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

// The run mode, and a stand-in for the real half (realHalf): its factory runs only when the module is loaded, so
// `loads` is the module-load spy that proves simulated mode never reaches Clerk's code.
const h = vi.hoisted(() => ({ simulated: true, loads: 0, seen: [] as string[] }))
vi.mock('./run-mode', () => ({
    get isSimulated() {
        return h.simulated
    },
}))
function realHalf() {
    h.loads += 1
    return {
        withClerk:
            (proxy: (request: NextRequest, event: NextFetchEvent) => unknown) =>
            async (request: NextRequest, event: NextFetchEvent) => {
                h.seen.push('clerk')
                return proxy(request, event)
            },
    }
}

const event = { waitUntil: () => {} } as unknown as NextFetchEvent
const appProxy = vi.fn((request: NextRequest) => {
    h.seen.push(`app ${request.nextUrl.pathname}`)
    const response = NextResponse.next()
    response.headers.set('x-app-proxy', 'ran')
    return response
})

async function load() {
    return (await import('./proxy')).withAuthProxy(appProxy)
}

beforeEach(() => {
    vi.resetModules()
    // Registered afresh for each test (a hoisted vi.mock's factory result outlives vi.resetModules), so `loads`
    // counts this test's loads only.
    vi.doMock('./real/clerk-proxy', realHalf)
    h.loads = 0
    h.seen = []
    appProxy.mockClear()
})

describe('withAuthProxy in simulated mode', () => {
    test("runs the app's proxy as it is and never loads Clerk's middleware", async () => {
        h.simulated = true
        const proxy = await load()
        const request = new NextRequest('http://localhost:3100/en/items')
        const response = await proxy(request, event)
        expect(response?.headers.get('x-app-proxy')).toBe('ran')
        expect(appProxy).toHaveBeenCalledWith(request, event)
        expect(h.seen).toEqual(['app /en/items'])
        expect(h.loads).toBe(0)
    })
})

describe('withAuthProxy in real mode', () => {
    test("runs the app's proxy inside Clerk's middleware, on pages and API routes alike", async () => {
        h.simulated = false
        const proxy = await load()
        expect(h.loads).toBe(0) // nothing is loaded before the first request
        const page = await proxy(new NextRequest('https://app.example.org/en/items'), event)
        await proxy(new NextRequest('https://app.example.org/api/items'), event)
        expect(page?.headers.get('x-app-proxy')).toBe('ran')
        expect(h.seen).toEqual(['clerk', 'app /en/items', 'clerk', 'app /api/items'])
        expect(h.loads).toBe(1)
    })
})
