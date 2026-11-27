import { originProblem } from './origin-form'

/**
 * What a request tells the server about the visitor: the origin they asked for (`publicOrigin`) and the address they
 * connect from (`clientAddress`). Neither is on the request where it looks to be. Behind `SssbApp`, Next's
 * `request.url` names the server's own bind address and port, never the visitor's host (Next builds it from where it
 * listens: `next/dist/server/lib/router-utils/resolve-routes.js` and `next-server.js`, `attachRequestMeta`), and the
 * first `X-Forwarded-For` entry is whatever the visitor wrote there (CloudFront appends the address it saw after the
 * visitor's entries: CloudFront's guide, "Request and response behavior for custom origins", "Client IP addresses").
 *
 * Forwarded headers are believed only where the deployment says every request passed a proxy that overwrites them:
 * `SSSB_EDGE=cloudfront`, which `SssbApp` sets on its server. Its distribution's viewer-request CloudFront Function
 * (`@sssb/cdk`'s `forwarded-host.js`) runs on every behavior that reaches the server and writes, over anything the
 * visitor sent, `x-forwarded-host` (the `Host` CloudFront routed by, port dropped) and `x-sssb-viewer-address`
 * (the address CloudFront took from the connection, `event.viewer.ip`: CloudFront's guide, "CloudFront Functions event
 * structure"). The Function URL admits only signed callers (IAM auth): a distribution given an origin access grant, and
 * the account's own principals; and `SssbApp` refuses to synthesize a behavior that reaches the
 * server without the function. Anywhere else, `pnpm dev` and a real-mode server of your own included, those headers
 * are the client's to write, so neither helper reads them.
 *
 * `SSSB_EDGE` is `SssbApp`'s alone: it is refused off Lambda (no `AWS_LAMBDA_FUNCTION_NAME`), where a deployment's
 * environment copied into `dev:real` would otherwise have the server believe headers any client writes. A request that
 * reached the server without crossing the function (the scheduled tick invokes the server directly) carries no
 * `x-sssb-viewer-address`, and Next fills a missing `x-forwarded-host` from `Host` (`base-server.js`), the Function
 * URL's own: so `publicOrigin` takes the forwarded host only beside a viewer address, and only when it is not `Host`.
 */

/** The header `SssbApp`'s viewer-request function writes the visitor's address into (`event.viewer.ip`). */
export const VIEWER_ADDRESS_HEADER = 'x-sssb-viewer-address'

/** The value of `SSSB_EDGE` that `SssbApp` sets on its server, the only one there is. */
export const SSSB_EDGE_CLOUDFRONT = 'cloudfront'

type Env = Readonly<Record<string, string | undefined>>

/** The headers a request carries; a `Request`, `NextRequest`, or the `Headers` from `next/headers`. */
type HasHeaders = { readonly headers: Pick<Headers, 'get'> }

/**
 * The origin a visitor reaches the app on (`https://app.example.org`, no trailing slash), for an absolute URL the app
 * builds: a link in an email, a URL it stores. A redirect needs none: Next's `redirect('/path')` and a relative URL
 * are right as they are.
 *
 * In order:
 * 1. `PUBLIC_ORIGIN`, when the server's environment sets it: the origin it is written as (a bare `https` origin, or
 *    `http` on `localhost`, `127.0.0.1` or `[::1]`), in a request or outside one. Set it where a deployment is served
 *    from more than one origin (a custom domain and the distribution's `*.cloudfront.net`), so every link names the
 *    one you mean, and wherever an absolute URL is built outside a request (a job, a scheduled email).
 * 2. In a request, behind `SssbApp` (`SSSB_EDGE=cloudfront`): `https://` and the `x-forwarded-host` its function
 *    wrote. Every behavior redirects HTTP to HTTPS, and the visitor reached port 443.
 * 3. In a request anywhere else (`pnpm dev`, a server of your own): the request's own origin, `request.url`'s. Behind
 *    a proxy or a tunnel of your own, set `PUBLIC_ORIGIN` instead.
 *
 * Throws, naming `PUBLIC_ORIGIN`, outside a request without it, and behind `SssbApp` on a request that reached the
 * server without crossing the distribution's function (the scheduled tick's, which invokes it directly); and on a
 * malformed `PUBLIC_ORIGIN` or `SSSB_EDGE`, rather than build a link from it.
 */
export function publicOrigin(request?: HasHeaders & { readonly url: string }): string {
    return publicOriginFrom(process.env, request)
}

/**
 * The address the visitor connects from (`198.51.100.7`, `2001:db8::1`), for what keys on it: a rate limit, a
 * lockout, an audit record's "from". `undefined` where the server cannot know it: in `pnpm dev`, on a server that is
 * not behind `SssbApp` (`SSSB_EDGE` unset), and on a request that did not cross the distribution. A caller must treat
 * `undefined` as unknown (one shared bucket for a rate limit, say), never as a free pass. One IPv6 visitor usually
 * holds a whole /64, so a limit keyed on the full address is one a visitor can multiply.
 *
 * It never reads `X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP` or `Forwarded`: behind CloudFront the first
 * `X-Forwarded-For` entry and the next two hold what the visitor wrote (CloudFront appends the address it saw after the
 * visitor's entries), and `SssbApp`'s function drops a visitor's `Forwarded`, which anywhere else is theirs too.
 */
export function clientAddress(request: HasHeaders): string | undefined {
    return clientAddressFrom(process.env, request)
}

/** `publicOrigin` over a given environment. Exported for tests. */
export function publicOriginFrom(env: Env, request?: HasHeaders & { readonly url: string }): string {
    const configured = configuredOrigin(env)
    if (configured) return configured
    if (!request) {
        throw new Error(
            "publicOrigin(): no request to read the visitor's origin from, and PUBLIC_ORIGIN is unset. Set the " +
                "server's PUBLIC_ORIGIN to the origin the app is served from (https://app.example.org)",
        )
    }
    if (!behindSssbEdge(env)) return new URL(request.url).origin
    const host = request.headers.get('x-forwarded-host')
    // The viewer address is the proof the request crossed the function, which writes it on every request; and a
    // forwarded host equal to Host is the one Next filled in from the Function URL's own.
    const crossed = clientAddressFrom(env, request) !== undefined && host !== request.headers.get('host')
    if (!crossed || host === null || !HOST.test(host)) {
        throw new Error(
            "publicOrigin(): behind SssbApp (SSSB_EDGE=cloudfront), the request carries no host the distribution's " +
                'function wrote (it did not cross the distribution: the scheduled tick invokes the server directly). ' +
                "Set the server's PUBLIC_ORIGIN to the origin the app is served from",
        )
    }
    return `https://${host}`
}

/**
 * Refuses a malformed `PUBLIC_ORIGIN` or `SSSB_EDGE`, as the helpers would when first called, so a real server's boot
 * check (`assertRealEnv`, and with it `sssb check-real-env`) names it before a deploy. Both are optional.
 */
export function assertEdgeSettings(env: Env): void {
    configuredOrigin(env)
    behindSssbEdge(env)
}

/** `clientAddress` over a given environment. Exported for tests. */
export function clientAddressFrom(env: Env, request: HasHeaders): string | undefined {
    if (!behindSssbEdge(env)) return undefined
    const address = request.headers.get(VIEWER_ADDRESS_HEADER)
    return address !== null && isIpAddress(address) ? address : undefined
}

/**
 * A host as `SssbApp`'s function writes it: lower case, no port, made of DNS labels (an internationalised name is
 * its `xn--` form by then). One value, so a comma-joined list a second proxy appended to is refused.
 */
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/

function configuredOrigin(env: Env): string | undefined {
    const value = env['PUBLIC_ORIGIN']
    if (value === undefined) return undefined
    const problem = originProblem(value)
    if (problem) {
        throw new Error(
            `PUBLIC_ORIGIN "${value}" ${problem}. Set it to the origin the app is served from ` +
                '(https://host[:port]), or unset it',
        )
    }
    return value
}

function behindSssbEdge(env: Env): boolean {
    const value = env['SSSB_EDGE']
    if (value === undefined || value === '') return false
    if (value !== SSSB_EDGE_CLOUDFRONT) {
        throw new Error(
            `SSSB_EDGE "${value}" is not "${SSSB_EDGE_CLOUDFRONT}", the one value there is. SssbApp sets it on its ` +
                'server; unset it anywhere else',
        )
    }
    if (!env['AWS_LAMBDA_FUNCTION_NAME']) {
        throw new Error(
            'SSSB_EDGE is set off Lambda (no AWS_LAMBDA_FUNCTION_NAME). SssbApp sets it on its server, behind the ' +
                'distribution that writes the headers it vouches for; anywhere else a client writes them. Unset it',
        )
    }
    return true
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/

/**
 * An IPv4 address in dotted decimal, or an IPv6 address as CloudFront writes `viewer.ip`; checked by `URL`, which
 * parses an IPv6 host and refuses anything else in brackets. No `node:net`, so the module also loads where the
 * proxy runs on the edge runtime.
 */
function isIpAddress(value: string): boolean {
    if (IPV4.test(value)) return true
    if (!value.includes(':') || !/^[0-9a-fA-F:.]+$/.test(value)) return false
    try {
        return new URL(`http://[${value}]/`).hostname !== ''
    } catch {
        return false
    }
}
