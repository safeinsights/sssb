import { RuleTester } from 'eslint'
import tseslint from 'typescript-eslint'
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
        // In the app's proxy, a redirect or rewrite built against the request's URL: Next relativizes a same-origin
        // Location the proxy answers with.
        { code: "NextResponse.redirect(new URL('/en', request.url))", filename: 'apps/any-app/src/proxy.ts' },
        { code: "NextResponse.rewrite(new URL('/en/x', request.nextUrl))", filename: 'src/middleware.js' },
        // Not a request's headers: search parameters, the environment, a map, a parsed DSN.
        { code: "u.searchParams.get('host')" },
        { code: "process.env['HOST']" },
        { code: "config.get('host')" },
        { code: "dsn['host']" },
        { code: 'const { pathname, searchParams } = new URL(request.url)' },
        { code: 'const { pathname } = request.nextUrl' },
        { code: "const link = new URL('/x', publicOrigin(request))" },
        { code: 'sendOrgInvite({ baseUrl: publicOrigin(request) })' },
        // A variable holding the request's whole URL, read only for its path and search parameters.
        { code: "const u = new URL(request.url); const q = u.searchParams.get('x'); const p = u.pathname" },
        { code: "const u = request.nextUrl; if (u.pathname === '/x') f(u.searchParams.get('y'))" },
        // ... or written again before it is sent on: the rule follows only a variable that keeps its first value.
        { code: "let u = new URL(request.url); u = new URL('/x', publicOrigin(request)); Response.redirect(u)" },
        // A redirect to a URL that is not the request's: a payment session's, the path alone.
        { code: 'NextResponse.redirect(session.url, 303)' },
        { code: "redirect('/en/dashboard')" },
        // The string request.url, stringified: already a string, and nearly always a log line.
        { code: 'log(`failed: ${request.url}`)' },
        { code: 'const where = `${request.nextUrl.pathname}?${request.nextUrl.searchParams}`' },
        // In the app's proxy, the request's own URL, or a clone of it with a new path, handed to a redirect or rewrite.
        ...[
            "const u = request.nextUrl.clone(); u.pathname = '/en'; return NextResponse.redirect(u)",
            "const u = new URL(request.url); u.pathname = '/en'; return NextResponse.rewrite(u)",
            "const u = request.nextUrl.clone(); return NextResponse.redirect(new URL('/en', u))",
            'NextResponse.redirect(request.url)',
            'NextResponse.rewrite(request.nextUrl)',
        ].map((code) => ({ code: `function f(request) { ${code} }`, filename: 'apps/any-app/src/proxy.ts' })),
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
        // Outside the proxy, Next does not relativize a redirect: a route handler's would send the visitor to the
        // server's bind address.
        ...[
            "NextResponse.redirect(new URL('/en/dashboard', request.url))",
            "Response.redirect(new URL('/en', request.url), 307)",
            "NextResponse.rewrite(new URL('/en/x', request.nextUrl))",
        ].map((code) => ({
            code,
            filename: 'apps/any-app/src/app/api/callback/route.ts',
            errors: [{ messageId: 'origin' }],
        })),
        // ... nor a redirect or rewrite of the request's whole URL, or of a variable that holds it, with a new path or
        // without one: Next's documented `nextUrl.clone()` idiom included.
        ...[
            "const u = request.nextUrl.clone(); u.pathname = '/x'; return Response.redirect(u)",
            'const { nextUrl } = request; return NextResponse.redirect(nextUrl.clone())',
            'return Response.redirect(request.url)',
            'return NextResponse.redirect(req.url, 307)',
            'return NextResponse.redirect(ctx.request.url)',
            'return NextResponse.redirect(request.nextUrl)',
            'return NextResponse.rewrite(request.url)',
            'return NextResponse.rewrite(new URL(request.url))',
            'redirect(request.url)',
            'permanentRedirect(request.nextUrl)',
            "const u = new URL(request.url); u.pathname = '/x'; return Response.redirect(u)",
            'let u = request.nextUrl; return NextResponse.rewrite(u, { headers: h })',
        ].map((code) => ({
            code: `function f(request, req, ctx) { ${code} }`,
            filename: 'apps/any-app/src/app/api/callback/route.ts',
            errors: [{ messageId: 'origin' }],
        })),
        // The request's whole URL as a string, directly or through a variable, anywhere (the proxy below too).
        ...[
            'const s = String(new URL(request.url))',
            'const s = String(request.nextUrl)',
            'const s = new URL(request.url).toString()',
            'const s = request.nextUrl.toString()',
            'const s = new URL(req.url).toJSON()',
            'const s = `${request.nextUrl}`',
            'const s = `${new URL(request.url)}`',
            'const s = `${request.nextUrl.clone()}`',
            'const u = new URL(request.url); const s = String(u)',
            'const u = new URL(request.url); const s = u.toString()',
            'const u = request.nextUrl; const s = `${u}/x`',
            // ... and, through a variable, the forms the rule takes from the request itself.
            'const u = new URL(request.url); const o = u.origin',
            "const u = new URL(request.url); u.pathname = '/x'; const h = u.href",
            'const u = request.nextUrl; const { host } = u',
            "const u = new URL(request.url); const l = new URL('/x', u)",
            'const u = new URL(request.url); sendOrgInvite({ baseUrl: u })',
        ].map((code) => ({ code, errors: [{ messageId: 'origin' }] })),
        // A file named like the proxy that is not Next's proxy: a route handler's wrapper, the framework's own.
        ...[
            'apps/any-app/src/lib/auth/middleware.ts',
            'apps/any-app/src/app/proxy.ts',
            'packages/kit/src/adapters/proxy.ts',
        ].map((filename) => ({
            code: "NextResponse.redirect(new URL('/sign-in', request.url))",
            filename,
            errors: [{ messageId: 'origin' }],
        })),
        // The proxy keeps every other form.
        {
            code: "const link = new URL('/en', request.url).toString()",
            filename: 'apps/any-app/src/proxy.ts',
            errors: [{ messageId: 'origin' }],
        },
        {
            code: "request.headers.get('x-forwarded-for')",
            filename: 'apps/any-app/src/proxy.ts',
            errors: [{ messageId: 'header' }],
        },
        // ... and a string of the request's whole URL, a clone's included, or a URL built on one that is not handed
        // straight to a redirect.
        ...[
            'const s = request.nextUrl.clone().toString()',
            'const s = `${request.nextUrl}`',
            'const u = request.nextUrl.clone(); const s = String(u)',
            "const u = request.nextUrl.clone(); const l = new URL('/x', u); headers.set('x-next', l.href)",
            'const u = request.nextUrl.clone(); const o = u.origin',
        ].map((code) => ({ code, filename: 'apps/any-app/src/proxy.ts', errors: [{ messageId: 'origin' }] })),
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

    // Through the repo's TypeScript parser and its scope analysis, as an app's route handler is linted.
    const CLONED =
        "import type { NextRequest } from 'next/server'\n" +
        'export function GET(request: NextRequest): Response {\n' +
        '    const url = request.nextUrl.clone()\n' +
        "    url.pathname = '/en/dashboard'\n" +
        '    return Response.redirect(url)\n' +
        '}\n'
    const REBUILT = CLONED.replace('request.nextUrl.clone()', 'new URL(request.url)')
    it.each([
        ['a clone', `${APP}/src/app/api/things/route.ts`, CLONED, 1],
        ['a new URL', `${APP}/src/app/api/things/route.ts`, REBUILT, 1],
        ['a clone', `${APP}/src/proxy.ts`, CLONED, 0],
        ['a new URL', `${APP}/src/proxy.ts`, REBUILT, 0],
    ])('counts a redirect to %s of the request URL in %s', async (_, path, code, times) => {
        expect((await lint(path, code)).filter((f) => f.rule === rule)).toHaveLength(times)
    })
})

// The review of the first cut of the redirect forms (each snippet one it reported or missed), and TypeScript's
// wrappers, which need typescript-eslint's parser.
const tsRuleTester = new RuleTester({
    languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
})
const ROUTE = 'apps/any-app/src/app/api/callback/route.ts'
const PROXY = 'apps/any-app/src/proxy.ts'
const inFunction = (code: string) => `async function f(request, req, ctx) { ${code} }`

tsRuleTester.run('sssb/no-raw-request-origin, followed', sssb.rules['no-raw-request-origin'], {
    valid: [
        // A URL that is not the request's, whatever its object is called: `new URL(<x>.url)` is the request's only
        // when <x> is named like a request.
        ...[
            "const url = new URL(row.url); url.searchParams.set('utm', 'x'); return url.toString()",
            "const u = new URL(webhook.url); await fetch(u.toString(), { method: 'POST' })",
            "const url = new URL(body.url); if (url.hostname !== 'ok.example') throw 1",
            'const loc = new URL(response.url); if (loc.origin !== expected) throw 1',
            'const h = new URL(body.url).hostname',
            "const loc = new URL(res.headers.get('location'), upstream.url)",
            'NextResponse.redirect(new URL(session.url))',
            'const u = new URL(session.url); return NextResponse.redirect(u)',
            'String(new URL(cfg.url))',
            'new URL(link.url).toString()',
            'sendOrgInvite({ baseUrl: config.url })',
            // A domain object whose name ends in "request" is not one.
            'redirect(accessRequest.url)',
            'redirect(pullRequest.url)',
            'const dataRequest = await load(id); return NextResponse.redirect(dataRequest.url)',
            // A nextUrl that is not a request's, handed to a redirect.
            'router.redirect(state.nextUrl)',
            // A clone used for its query alone.
            "const u = request.nextUrl.clone(); u.searchParams.delete('x'); const qs = u.searchParams.toString()",
            // The visitor's origin, the path and the query.
            "NextResponse.redirect(new URL('/en/dashboard' + request.nextUrl.search, publicOrigin(request)))",
            'const u = new URL(request.url); return Response.json({ next: u.pathname + u.search })',
            "const u = (new URL(request.url) as URL)!; if (u!.pathname === '/x') g((u as URL).searchParams)",
        ].map((code) => ({ code: inFunction(code), filename: ROUTE })),
        // In the proxy Next relativizes the Location however it was built: a string of the request's URL, and a URL
        // on it whose every use is a redirect's argument or its path and query.
        ...[
            'const u = request.nextUrl.clone(); return NextResponse.redirect(u.toString())',
            'const u = request.nextUrl; return NextResponse.redirect(u.href)',
            "return NextResponse.redirect(new URL('/x', request.url).toString())",
            'return NextResponse.redirect(request.nextUrl.clone().toString())',
            "const login = new URL('/login', request.url); login.searchParams.set('from', request.nextUrl.pathname); " +
                'return NextResponse.redirect(login)',
            "const u = new URL('/x', request.url) as URL; return NextResponse.redirect(u!)",
        ].map((code) => ({ code: inFunction(code), filename: PROXY })),
    ],
    invalid: [
        ...[
            // Through TypeScript's wrappers, on the use and on the initial value.
            'const url = new URL(request.url); return Response.redirect(url!)',
            'const url = new URL(request.url); return Response.redirect(url as unknown as string)',
            'const u = request.nextUrl!; return NextResponse.redirect(u)',
            'const u = new URL(request.url) as URL; return String(u)',
            'const u = new URL(request.url) satisfies URL; return u.toString()',
            'const u = request.nextUrl; return (u as URL).href',
            'const u = request.nextUrl; return u?.origin',
            // Concatenated with a string.
            "const url = new URL(request.url); return Response.redirect(url + '')",
            "const url = new URL(request.url); return new Response(null, { status: 302, headers: { Location: '' + url } })",
            // A clone that is not a variable's initial value is reported where it is made.
            'return Response.redirect(request.nextUrl.clone())',
            // An alias of an alias.
            'const u = request.nextUrl; const v = u; return Response.redirect(v)',
            // The string request.url, into a redirect as a string of itself.
            'redirect(`${request.url}`)',
            'redirect(String(request.url))',
        ].map((code) => ({ code: inFunction(code), filename: ROUTE, errors: [{ messageId: 'origin' as const }] })),
        // In the proxy, a URL on the request with a use that is not a redirect's, and a string of one sent elsewhere.
        ...[
            "const login = new URL('/login', request.url); res.headers.set('x-next', login.href)",
            "const u = request.nextUrl.clone(); res.headers.set('x-url', u.href)",
        ].map((code) => ({ code: inFunction(code), filename: PROXY, errors: [{ messageId: 'origin' as const }] })),
    ],
})
