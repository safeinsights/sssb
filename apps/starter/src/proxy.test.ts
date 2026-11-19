// @vitest-environment node
import { NextRequest, NextResponse, type NextFetchEvent } from 'next/server'
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { describe, expect, it, vi } from 'vitest'
import proxy, { config } from './proxy'

// next-intl's middleware does not load under Vitest (its ESM imports `next/server` without an extension), so a
// stand-in marks the requests it is handed.
vi.mock('next-intl/middleware', () => ({
    default: () => (request: NextRequest) =>
        NextResponse.redirect(new URL(`/en${request.nextUrl.pathname}`, request.url)),
}))

// The proxy as Next runs it, in simulated mode (the test's run mode): which paths reach it, and what it does there.
// In real mode the same proxy runs inside the auth provider's middleware, which must see every page and API route.
function run(path: string) {
    const request = new NextRequest(`http://localhost:3100${path}`)
    return proxy(request, { waitUntil: () => {} } as unknown as NextFetchEvent)
}

describe('the proxy', () => {
    it.each(['/', '/en/projects', '/es', '/api', '/api/projects', '/api/webhooks/cron', '/api/projects/report.csv'])(
        'is run on %s',
        (path) => {
            expect(unstable_doesMiddlewareMatch({ config, url: path })).toBe(true)
        },
    )

    it.each(['/_next/static/chunk.js', '/favicon.ico', '/_vercel/insights', '/apiary'])('is not run on %s', (path) => {
        expect(unstable_doesMiddlewareMatch({ config, url: path })).toBe(false)
    })

    it('hands a page to the locale routing', async () => {
        const response = await run('/projects')
        expect(response?.headers.get('location')).toBe('http://localhost:3100/en/projects')
    })

    it('passes an API route through untouched', async () => {
        const response = await run('/api/projects')
        expect(response?.headers.get('x-middleware-next')).toBe('1')
        expect(response?.headers.get('location')).toBeNull()
        expect(response?.headers.get('x-middleware-rewrite')).toBeNull()
    })
})
