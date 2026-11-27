import { RuleTester } from 'eslint'
import { describe, expect, it } from 'vitest'
import sssb from '@sssb/eslint-plugin'
import { APP, lint } from './lint-text'

/**
 * Pins what `sssb/no-raw-request-origin` (@sssb/eslint-plugin) does and does not match, and where the repo's config
 * runs it. The visitor's origin and address come from @sssb/kit/adapters/edge-headers (safeinsights/sssb#131, #132):
 * behind SssbApp, `request.url`'s origin names the server's bind address and the first X-Forwarded-For entry is the
 * visitor's to write.
 */
RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester({ languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } })

ruleTester.run('sssb/no-raw-request-origin', sssb.rules['no-raw-request-origin'], {
    valid: [
        // The path and the search parameters of the request's own URL are right.
        { code: "const p = new URL(request.url).searchParams.get('status')" },
        { code: 'const path = request.nextUrl.pathname' },
        { code: 'const path = new URL(request.url).pathname' },
        // A redirect or rewrite built against the request's URL: Next relativizes a same-origin Location.
        { code: "NextResponse.redirect(new URL('/en', request.url))" },
        { code: "NextResponse.rewrite(new URL('/en/x', request.nextUrl))" },
        { code: "Response.redirect(new URL('/en', request.url), 307)" },
        // Not a request's headers: search parameters, the environment, a map, a parsed DSN.
        { code: "u.searchParams.get('host')" },
        { code: "process.env['HOST']" },
        { code: "config.get('host')" },
        { code: "dsn['host']" },
        { code: 'const { pathname, searchParams } = new URL(request.url)' },
        { code: 'const { pathname } = request.nextUrl' },
        { code: "const link = new URL('/x', publicOrigin(request))" },
        { code: 'sendOrgInvite({ baseUrl: publicOrigin(request) })' },
        // Headers that name nothing about the visitor's host or address.
        { code: "request.headers.get('content-type')" },
        { code: "request.headers.get('x-forwarded-hostname')" },
        { code: "const h = { 'x-forwarded-for': '1.2.3.4' }" },
        // A name held elsewhere gets past, as any alias does.
        { code: 'request.headers.get(name)' },
        { code: 'request.headers.get(`x-forwarded-${part}`)' },
        // An origin that is not the request's.
        { code: 'const o = new URL(link).origin' },
        { code: 'const o = window.location.origin' },
    ],
    invalid: [
        ...[
            'x-forwarded-for',
            'X-Forwarded-For',
            'x-forwarded-host',
            'x-forwarded-proto',
            'x-forwarded-port',
            'x-real-ip',
            'x-client-ip',
            'cf-connecting-ip',
            'true-client-ip',
            'forwarded',
            'host',
            'CloudFront-Viewer-Address',
            'x-sssb-viewer-address',
        ].map((name) => ({ code: `request.headers.get('${name}')`, errors: [{ messageId: 'header' }] })),
        { code: "(await headers()).get('x-forwarded-for')", errors: [{ messageId: 'header' }] },
        { code: "headers().get('x-forwarded-for')", errors: [{ messageId: 'header' }] },
        { code: "headersList.get('x-forwarded-host')", errors: [{ messageId: 'header' }] },
        { code: "requestHeaders.get('X-Real-IP')", errors: [{ messageId: 'header' }] },
        { code: "request.headers.has('x-real-ip')", errors: [{ messageId: 'header' }] },
        { code: 'request.headers.get(`x-forwarded-for`)', errors: [{ messageId: 'header' }] },
        { code: "req.headers['x-forwarded-for']", errors: [{ messageId: 'header' }] },
        { code: 'const o = new URL(request.url).origin', errors: [{ messageId: 'origin' }] },
        { code: 'const o = new URL(req.url).host', errors: [{ messageId: 'origin' }] },
        { code: 'const o = new URL(request.url).hostname', errors: [{ messageId: 'origin' }] },
        { code: 'const o = request.nextUrl.origin', errors: [{ messageId: 'origin' }] },
        { code: 'const o = request.nextUrl.host', errors: [{ messageId: 'origin' }] },
        { code: 'const o = request.nextUrl.href', errors: [{ messageId: 'origin' }] },
        { code: 'const o = new URL(request.url).href', errors: [{ messageId: 'origin' }] },
        { code: 'const { origin } = new URL(request.url)', errors: [{ messageId: 'origin' }] },
        { code: 'const { host: h } = request.nextUrl', errors: [{ messageId: 'origin' }] },
        {
            code: "const link = new URL('/en/accept-invite', request.url).toString()",
            errors: [{ messageId: 'origin' }],
        },
        { code: "const link = new URL('/en', request.nextUrl)", errors: [{ messageId: 'origin' }] },
        { code: 'sendOrgInvite({ baseUrl: request.url })', errors: [{ messageId: 'origin' }] },
    ],
})

describe("where the repo's config runs sssb/no-raw-request-origin", () => {
    const READS = "export const from = (request: Request) => request.headers.get('x-forwarded-for')\n"
    const rule = 'sssb/no-raw-request-origin'
    const fired = async (path: string) => (await lint(path, READS)).some((f) => f.rule === rule)

    it.each([
        `${APP}/src/app/api/things/route.ts`,
        `${APP}/src/domain/rate-limit.ts`,
        `${APP}/src/components/Banner.ts`,
        'packages/kit/src/server-lib/anything.ts',
        'packages/kit/test-fixture/api/anything.ts',
    ])('fires in %s', async (path) => {
        expect(await fired(path)).toBe(true)
    })

    it.each([
        // A test builds the requests it sends.
        `${APP}/src/app/api/things/route.test.ts`,
        // The one module that reads them.
        'packages/kit/src/adapters/edge-headers.ts',
    ])('does not fire in %s', async (path) => {
        expect(await fired(path)).toBe(false)
    })
})
