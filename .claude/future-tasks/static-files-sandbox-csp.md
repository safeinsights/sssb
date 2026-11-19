# A sandboxing Content-Security-Policy for the static files

**Priority:** P3 · **Status:** open
**Found by:** the security review of `fix/cdk-hsts` (2026-11-19).

## What happens

`SssbApp`'s distribution serves `/_next/static/*` and `/assets/*` from its assets bucket, on the app's own origin. A
file there stored as `text/html` or `image/svg+xml`, opened directly, runs its script on the app's origin, with the
app's cookies in reach. Only the deploy pipeline writes that bucket (the server has no grant), so this takes a
mistake, or a compromised build, rather than a visitor. The security headers `fix/cdk-hsts` added (AWS's managed
SecurityHeadersPolicy) do not stop it: nosniff stops a file being run as a type it is not labelled as, not a file
labelled as HTML.

## The fix, sketched

A second response headers policy, on the two static behaviors only, with SecurityHeadersPolicy's headers plus
`Content-Security-Policy: default-src 'none'; sandbox`. Scripts and stylesheets loaded by the app's pages are
unaffected: a CSP applies to the document it arrives with, and these files are subresources. It costs one of the
account's 20 custom response headers policies per deployment, the quota `fix/cdk-hsts` kept the default policy out of.
So decide that first. The options are:

- a policy shared by every SSSB deployment in the account (created once, its id passed in);
- the cost accepted, behind a switch;
- an origin-response function instead, which costs a Lambda@Edge association on the static behaviors and their cache
  misses.

Prove it live: an HTML file uploaded to `/assets/` and opened through `DistributionDomain` runs no script, and the app's
pages still load their `/_next/static/` files.
