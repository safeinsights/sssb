# `X-Forwarded-For`'s first entry is the viewer's to choose

**Priority:** P2 · **Status:** open
**Found by:** the security review of `fix/cdk-forwarded-host-https` (2026-11-19).

## What happens

A viewer may send `X-Forwarded-For` with any addresses in it. CloudFront keeps what the viewer sent and appends the
address it took from the TCP connection (CloudFront's guide, "Request and response behavior for custom origins",
"Client IP addresses"). The origin request policy forwards the result, and the Function URL may add more entries
after it. So the **first** entry of the header the app sees is whatever the viewer wrote. Only an entry CloudFront
added can be trusted.

## What reads it today

Nothing in `packages/kit/src` or `apps/starter/src` reads `X-Forwarded-For` (searched).

`@clerk/backend` 3.29.0's `getClientIp` (`dist/proxy.mjs`) takes `cf-connecting-ip`, then `x-real-ip`, then the
first `X-Forwarded-For` entry. Behind CloudFront every one of those is the viewer's: `cf-connecting-ip` is
Cloudflare's header, which CloudFront forwards as the viewer sent it, and CloudFront removes `x-real-ip`. It lives in
Clerk's Frontend API proxy module, which SSSB does not use; read it again if that changes.

## What must not

Anything that keys on the client's address must not take the first entry: a rate limit, a lockout, an audit log's
"from", an allow-list. Take one of these instead:

- `CloudFront-Viewer-Address`. CloudFront sets it and overwrites a viewer's. Check first that `SssbApp`'s origin
  request policy (`AllViewerExceptHostHeader`) forwards it: CloudFront's guide says that policy carries "all device
  type and viewer location headers", but does not list them.
- The entry CloudFront appended, counted from the right, once a live request shows how many entries the Function URL
  adds after it.

## The fix, sketched

A kit helper, `clientAddress(request)`, that reads `CloudFront-Viewer-Address` (stripping its `:port`) and refuses to
fall back to the first `X-Forwarded-For` entry. A conformance or lint check would flag a direct
`headers.get('x-forwarded-for')` in app code. Prove it live first: send a forged `X-Forwarded-For: 1.2.3.4` through
`DistributionDomain` and read what the server logs for each header.
