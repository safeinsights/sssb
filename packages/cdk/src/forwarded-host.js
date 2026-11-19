// @ts-check
/**
 * The viewer-request CloudFront Function on every behavior that reaches the server (CloudFront Functions' JS 2.0
 * runtime: one `handler` and no modules, so it is kept as source). CloudFront must send the Function URL its own
 * `Host`, to sign the request, so the viewer's host reaches the app only as `x-forwarded-host`: Next fills that header
 * only when it is absent (next/dist/server/base-server.js), and Clerk's request URL, Next's server-action origin check
 * and next-intl's domain redirects read it (Next's own `request.url` keeps the Function URL's host). A viewer could
 * otherwise set it, and `x-forwarded-port` (next-intl's domain redirects read that too), to anything. So both are set
 * here from the request CloudFront received, overwriting what the viewer sent: the `Host` it routed by (lowercased, any
 * port dropped), and 443, the only port a viewer reaches the app on once every behavior redirects HTTP to HTTPS. A
 * viewer's RFC 7239 `Forwarded` is dropped, never being CloudFront's. `X-Forwarded-Proto` is CloudFront's: functions
 * may not touch it, and it removes a viewer's (CloudFront's guide, "Request and response behavior for custom
 * origins").
 */
export const FORWARDED_HOST_SOURCE = `function handler(event) {
    var request = event.request;
    var headers = request.headers;
    delete headers['forwarded'];
    var host = headers.host ? headers.host.value.toLowerCase().replace(/:[0-9]*$/, '') : '';
    if (host) {
        headers['x-forwarded-host'] = { value: host };
    } else {
        delete headers['x-forwarded-host'];
    }
    headers['x-forwarded-port'] = { value: '443' };
    return request;
}
`
