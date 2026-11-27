---
'@sssb/kit': patch
'@sssb/cdk': patch
---

### `PUBLIC_ORIGIN`, and the visitor's address from `SssbApp`'s edge

**Kind.** operator

**Action.** optional

**What changed.** `SssbApp`'s viewer-request CloudFront Function now also writes `x-sssb-viewer-address`, the address
CloudFront took from the visitor's connection, over any a visitor sent, and the construct sets `SSSB_EDGE=cloudfront` on
the server, which tells `@sssb/kit`'s `publicOrigin` and `clientAddress` to believe that header and `x-forwarded-host`.
Without `SSSB_EDGE` (in `pnpm dev`, or on a host of your own) neither reads a forwarded header. A new optional server
setting, `PUBLIC_ORIGIN`, is the origin `publicOrigin` returns wherever it is set, in a request and outside one. A
malformed `PUBLIC_ORIGIN`, or an `SSSB_EDGE` other than `cloudfront`, fails `sssb check-real-env` and the server's
boot, naming cutover row `domains-and-certs`.

**To adopt.** Redeploy with this `@sssb/cdk`. Once the deployment has a custom domain, set the server's `PUBLIC_ORIGIN`
to its origin, a bare origin with no trailing slash (`PUBLIC_ORIGIN=https://app.example.org`), so every link names it
rather than the host a visitor came in on; set it too wherever a job builds a link. A behavior of your own on
`sssbApp.distribution` that reaches the server must run `sssbApp.forwardedHost` on `viewer-request`, as before: without
it, a visitor writes the host and address the server believes.
