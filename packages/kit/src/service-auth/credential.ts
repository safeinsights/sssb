/**
 * The credential a machine caller presents: its own header when it sends one, else `Authorization: Bearer …`.
 *
 * Why not `Authorization` alone: a deployment's CloudFront distribution reaches the server's Lambda Function URL
 * through an origin access control that signs every origin request, and the signature IS the `Authorization` header,
 * which replaces whatever the caller sent (CloudFront's guide, "Restrict access to an AWS Lambda function URL origin",
 * signing behavior `always`). A credential in `Authorization` therefore never reaches a route behind the
 * distribution. A header of the credential's own does, so a caller that goes through the public host sends that one.
 * `Authorization: Bearer` is still read when the header is absent: for a caller that reaches the server another way
 * (a direct invocation, `pnpm dev`), and for senders written before the header.
 *
 * The header wins when present, even empty: it is never combined with or overridden by `Authorization`, which behind
 * the distribution is CloudFront's signature. Null when neither carries a credential.
 */
export function presentedCredential(request: Request, header: string): string | null {
    const own = request.headers.get(header)
    if (own !== null) return own
    const authorization = request.headers.get('authorization')
    return authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null
}
