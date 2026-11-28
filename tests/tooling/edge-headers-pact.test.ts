import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
    clientAddressFrom,
    publicOriginFrom,
    SSSB_EDGE_CLOUDFRONT,
    VIEWER_ADDRESS_HEADER,
} from '@sssb/kit/adapters/edge-headers'
import { FORWARDED_HOST_SOURCE } from '../../packages/cdk/src/forwarded-host.js'

/**
 * The two halves of one promise, in two packages that may not import each other (no SSSB package depends on another):
 * `@sssb/cdk`'s viewer-request CloudFront Function writes the visitor's host and address over whatever the visitor
 * sent, and `SssbApp` tells the server so (`SSSB_EDGE`); `@sssb/kit`'s `publicOrigin` and `clientAddress` believe
 * those headers only then. A header renamed on one side alone would leave the helper reading a header the visitor
 * writes, or none: this runs the function's real source on forged headers and hands what it forwards to the helpers.
 */
const handler = vm.runInNewContext(`${FORWARDED_HOST_SOURCE}\nhandler`, {}) as (event: unknown) => {
    headers: Record<string, { value: string }>
}

/** What CloudFront forwards to the server for a viewer request, after the function ran. */
function forwarded(viewerIp: string, headers: Record<string, string>): { url: string; headers: Headers } {
    const cfHeaders = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, { value }]))
    const out = handler({
        viewer: { ip: viewerIp },
        request: { method: 'GET', uri: '/', querystring: {}, headers: cfHeaders },
    })
    const sent = new Headers()
    for (const [name, { value }] of Object.entries(out.headers)) sent.set(name, value)
    // CloudFront appends the connection's address to the visitor's X-Forwarded-For.
    sent.set('x-forwarded-for', [headers['x-forwarded-for'], viewerIp].filter(Boolean).join(', '))
    // The origin request policy sends every viewer header but Host, which is the Function URL's (CloudFront signs for it).
    sent.set('host', 'abc123.lambda-url.us-east-1.on.aws')
    // Next's request.url behind SssbApp: its own bind address.
    return { url: 'https://localhost:3000/en', headers: sent }
}

const ENV = { SSSB_EDGE: SSSB_EDGE_CLOUDFRONT, AWS_LAMBDA_FUNCTION_NAME: 'app-server' }

describe("SssbApp's forwarded-host function and @sssb/kit's edge headers", () => {
    it('agree on the header names, so a forged visitor header never reaches the helpers', () => {
        const request = forwarded('198.51.100.7', {
            host: 'App.Example.org',
            'x-forwarded-host': 'evil.example',
            'x-forwarded-for': '1.2.3.4',
            [VIEWER_ADDRESS_HEADER]: '1.2.3.4',
        })
        expect(publicOriginFrom(ENV, request)).toBe('https://app.example.org')
        expect(clientAddressFrom(ENV, request)).toBe('198.51.100.7')
    })

    it('agree on the switch SssbApp sets on its server', () => {
        const source = readFileSync(path.resolve(__dirname, '../../packages/cdk/src/sssb-app.js'), 'utf8')
        expect(source).toContain(`SSSB_EDGE: '${SSSB_EDGE_CLOUDFRONT}',`)
    })
})
