---
'@sssb/cdk': patch
---

### `SssbApp` tells the app the host the viewer asked for, and redirects plain HTTP everywhere

**Kind.** operator

**Action.** optional

**What changed.** CloudFront sends the server's Function URL its own `Host`, and forwarded a viewer's
`X-Forwarded-Host` as sent, so what reads that header in a deployed app (Clerk's request URL, Next's server-action origin
check, next-intl's domain redirects) saw the Function URL's host, or one the viewer chose. `SssbApp` now runs a
viewer-request CloudFront Function on the default behavior that sets `x-forwarded-host` from the `Host` CloudFront
received (lowercased, any port dropped) and `x-forwarded-port` to 443, overwriting what the viewer sent, and drops a
viewer's `Forwarded`. Next's own `request.url` names the server's own address (`localhost` and its port), not the viewer's host. It is exposed as `forwardedHost`: associate it with any behavior of your own
that reaches the server. The `/_next/static/*` and `/assets/*` behaviors now redirect HTTP to HTTPS, as the default
behavior already did.

**To adopt.** Upgrade and run `cdk diff`. It shows a new `ForwardedHost` CloudFront Function, the distribution's
default behavior gaining a `FunctionAssociations` entry (`viewer-request`), and `ViewerProtocolPolicy` on the two static
behaviors changing from `allow-all` to `redirect-to-https`. No stateful resource changes. If you added a behavior of
your own that reaches the server, associate `forwardedHost` with it on `viewer-request`.

**Now deletable.** A CloudFront Function of your own that sets `x-forwarded-host` from the viewer's `Host`, and the
escape-hatch override (`FunctionAssociations` on the default behavior) that attaches it: keeping the override replaces
`SssbApp`'s association with yours.
