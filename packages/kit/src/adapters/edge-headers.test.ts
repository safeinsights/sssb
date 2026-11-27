import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientAddress, clientAddressFrom, publicOrigin, publicOriginFrom, VIEWER_ADDRESS_HEADER } from './edge-headers'

const EDGE = { SSSB_EDGE: 'cloudfront', AWS_LAMBDA_FUNCTION_NAME: 'app-server' }

/** The Function URL's host, which CloudFront sends as Host (it signs for it) and the scheduled tick sends too. */
const FUNCTION_URL_HOST = 'abc123.lambda-url.us-east-1.on.aws'

/** What the distribution's function leaves on every request that crossed it. */
const CROSSED = { host: FUNCTION_URL_HOST, [VIEWER_ADDRESS_HEADER]: '198.51.100.7' }

/** A request as the server sees it behind SssbApp: Next's URL names its own bind address. */
const request = (headers: Record<string, string> = {}, url = 'https://localhost:3000/en/invite?x=1') => {
    // Not a `Request`: the test environment's drops a Host header, and what Host says is part of the case.
    const sent = new Headers(headers)
    expect(sent.get('host')).toBe(headers['host'] ?? null)
    return { url, headers: sent }
}

describe('publicOrigin', () => {
    it('is PUBLIC_ORIGIN when it is set, in a request and outside one, whatever the request says', () => {
        const env = { ...EDGE, PUBLIC_ORIGIN: 'https://app.example.org' }
        expect(publicOriginFrom(env)).toBe('https://app.example.org')
        expect(publicOriginFrom(env, request({ 'x-forwarded-host': 'd111.cloudfront.net' }))).toBe(
            'https://app.example.org',
        )
        expect(publicOriginFrom({ PUBLIC_ORIGIN: 'http://localhost:3100' }, request())).toBe('http://localhost:3100')
    })

    it.each([
        ['https://app.example.org/', 'is not a bare origin'],
        ['https://App.example.org', 'is not a bare origin'],
        ['https://app.example.org/path', 'is not a bare origin'],
        ['https://app.example.org:443', 'is not a bare origin'],
        ['http://app.example.org', 'is not https'],
        ['app.example.org', 'is not a URL'],
        ['', 'is empty'],
        ['https://*.example.org', 'is a wildcard'],
    ])('refuses PUBLIC_ORIGIN %j rather than build a link from it', (value, problem) => {
        expect(() => publicOriginFrom({ PUBLIC_ORIGIN: value }, request())).toThrow(problem)
    })

    it("behind SssbApp, is https and the host its function wrote, never request.url's", () => {
        expect(publicOriginFrom(EDGE, request({ ...CROSSED, 'x-forwarded-host': 'app.example.org' }))).toBe(
            'https://app.example.org',
        )
    })

    it.each([
        ['absent', {}],
        ['empty', { 'x-forwarded-host': '' }],
        ['a list a second proxy appended to', { 'x-forwarded-host': 'app.example.org, evil.example' }],
        ['with a port', { 'x-forwarded-host': 'app.example.org:8443' }],
        ['upper case', { 'x-forwarded-host': 'App.example.org' }],
        ['with user info', { 'x-forwarded-host': 'evil.example@app.example.org' }],
        ['with a path', { 'x-forwarded-host': 'app.example.org/x' }],
    ])('behind SssbApp, throws naming PUBLIC_ORIGIN when the forwarded host is %s', (_, headers) => {
        expect(() => publicOriginFrom(EDGE, request({ ...CROSSED, ...headers }))).toThrow(/PUBLIC_ORIGIN/)
    })

    it("behind SssbApp, throws on the scheduled tick's request, whose forwarded host Next filled from Host", () => {
        // Next fills a missing x-forwarded-host from Host (base-server.js): the tick's is the Function URL's.
        const tick = { host: FUNCTION_URL_HOST, 'x-forwarded-host': FUNCTION_URL_HOST }
        expect(() => publicOriginFrom(EDGE, request(tick))).toThrow(/did not cross the distribution/)
        // Even beside a viewer address, a forwarded host equal to Host is Next's, not the function's.
        expect(() => publicOriginFrom(EDGE, request({ ...CROSSED, 'x-forwarded-host': FUNCTION_URL_HOST }))).toThrow(
            /did not cross the distribution/,
        )
        // A forwarded host the function did write, with no viewer address beside it, is not proof either.
        expect(() =>
            publicOriginFrom(EDGE, request({ host: FUNCTION_URL_HOST, 'x-forwarded-host': 'app.example.org' })),
        ).toThrow(/did not cross the distribution/)
    })

    it("off SssbApp (pnpm dev, a server of your own), is request.url's origin and ignores forwarded headers", () => {
        const forged = { 'x-forwarded-host': 'evil.example', host: 'evil.example', forwarded: 'host=evil.example' }
        expect(publicOriginFrom({}, request(forged, 'http://localhost:3000/en'))).toBe('http://localhost:3000')
        expect(publicOriginFrom({ SSSB_EDGE: '' }, request(forged, 'http://localhost:3100/'))).toBe(
            'http://localhost:3100',
        )
    })

    it('outside a request, throws naming PUBLIC_ORIGIN', () => {
        expect(() => publicOriginFrom({})).toThrow(/PUBLIC_ORIGIN is unset/)
        expect(() => publicOriginFrom(EDGE)).toThrow(/PUBLIC_ORIGIN is unset/)
    })

    it('refuses an SSSB_EDGE it does not know, rather than trust or ignore it', () => {
        expect(() => publicOriginFrom({ ...EDGE, SSSB_EDGE: 'true' }, request())).toThrow(/SSSB_EDGE "true"/)
    })

    it("refuses SSSB_EDGE off Lambda, where a deployment's environment copied into dev:real would trust any client", () => {
        const forged = request({ ...CROSSED, 'x-forwarded-host': 'evil.example' })
        expect(() => publicOriginFrom({ SSSB_EDGE: 'cloudfront' }, forged)).toThrow(/off Lambda/)
        expect(() => clientAddressFrom({ SSSB_EDGE: 'cloudfront' }, forged)).toThrow(/off Lambda/)
    })
})

describe('clientAddress', () => {
    it("behind SssbApp, is the address its function wrote, never X-Forwarded-For's first entry", () => {
        const headers = {
            'x-forwarded-for': '1.2.3.4, 198.51.100.7, 130.176.0.1',
            'x-real-ip': '1.2.3.4',
            'cf-connecting-ip': '1.2.3.4',
            [VIEWER_ADDRESS_HEADER]: '198.51.100.7',
        }
        expect(clientAddressFrom(EDGE, request(headers))).toBe('198.51.100.7')
        expect(clientAddressFrom(EDGE, request({ [VIEWER_ADDRESS_HEADER]: '2001:db8::1' }))).toBe('2001:db8::1')
    })

    it.each([
        ['absent (the request did not cross the distribution)', {}],
        ['not an address', { [VIEWER_ADDRESS_HEADER]: 'evil' }],
        ['a list', { [VIEWER_ADDRESS_HEADER]: '198.51.100.7, 1.2.3.4' }],
        ['an address and port', { [VIEWER_ADDRESS_HEADER]: '198.51.100.7:443' }],
        ['an IPv4 octet out of range', { [VIEWER_ADDRESS_HEADER]: '198.51.100.256' }],
        ['bracketed', { [VIEWER_ADDRESS_HEADER]: '[2001:db8::1]' }],
    ])('behind SssbApp, is undefined when the header is %s', (_, headers) => {
        expect(clientAddressFrom(EDGE, request({ 'x-forwarded-for': '1.2.3.4', ...headers }))).toBeUndefined()
    })

    it('off SssbApp, is undefined whatever the request carries', () => {
        const forged = { [VIEWER_ADDRESS_HEADER]: '1.2.3.4', 'x-forwarded-for': '1.2.3.4' }
        expect(clientAddressFrom({}, request(forged))).toBeUndefined()
    })

    it('reads the headers next/headers hands a server component as well as a request', () => {
        expect(clientAddressFrom(EDGE, { headers: new Headers({ [VIEWER_ADDRESS_HEADER]: '203.0.113.9' }) })).toBe(
            '203.0.113.9',
        )
    })
})

describe("the exported helpers read the server's own environment", () => {
    afterEach(() => {
        vi.unstubAllEnvs()
    })

    it('believe the edge headers under SSSB_EDGE=cloudfront, and PUBLIC_ORIGIN over them', () => {
        vi.stubEnv('PUBLIC_ORIGIN', undefined)
        vi.stubEnv('SSSB_EDGE', 'cloudfront')
        vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'app-server')
        const behind = request({ ...CROSSED, 'x-forwarded-host': 'app.example.org' })
        expect(publicOrigin(behind)).toBe('https://app.example.org')
        expect(clientAddress(behind)).toBe('198.51.100.7')
        vi.stubEnv('PUBLIC_ORIGIN', 'https://www.example.org')
        expect(publicOrigin(behind)).toBe('https://www.example.org')
        expect(publicOrigin()).toBe('https://www.example.org')
    })

    it('believe none of them without SSSB_EDGE', () => {
        vi.stubEnv('PUBLIC_ORIGIN', undefined)
        vi.stubEnv('SSSB_EDGE', undefined)
        const forged = request({ 'x-forwarded-host': 'evil.example', [VIEWER_ADDRESS_HEADER]: '1.2.3.4' })
        expect(publicOrigin(forged)).toBe('https://localhost:3000')
        expect(clientAddress(forged)).toBeUndefined()
    })
})
