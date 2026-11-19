// @ts-check
/**
 * The viewer-request CloudFront Function on every behavior that reaches the server (CloudFront Functions' JS 2.0
 * runtime: one `handler` and no modules, so it is kept as source). CloudFront must send the Function URL its own
 * `Host`, to sign the request, so the app learns the host the viewer asked for only from `x-forwarded-host`, which
 * Next fills only when it is absent and Clerk builds its URLs from. A viewer could otherwise set it, and the port Clerk
 * reads beside it, to anything. So both are set here from what CloudFront itself received, overwriting what the viewer
 * sent: the `Host` it routed by, and 443, the only port a viewer reaches the app on once every behavior redirects HTTP
 * to HTTPS. A viewer's RFC 7239 `Forwarded` is dropped, never being CloudFront's. `X-Forwarded-Proto` is CloudFront's
 * to manage (functions may not touch it, and it removes a viewer's), and the origin request policy forwards its own
 * `CloudFront-Forwarded-Proto`.
 */
export const FORWARDED_HOST_SOURCE = `function handler(event) {
    var request = event.request;
    var headers = request.headers;
    delete headers['forwarded'];
    if (headers.host && headers.host.value) {
        headers['x-forwarded-host'] = { value: headers.host.value };
    } else {
        delete headers['x-forwarded-host'];
    }
    headers['x-forwarded-port'] = { value: '443' };
    return request;
}
`
