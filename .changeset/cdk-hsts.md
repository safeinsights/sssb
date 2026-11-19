---
'@sssb/cdk': minor
---

### `SssbApp` sends HSTS and safe security headers

**Kind.** operator

**Action.** required

**What changed.** The three behaviors `SssbApp` builds (the app's pages, `/_next/static/*` and `/assets/*`) now carry
AWS's managed SecurityHeadersPolicy:

- `Strict-Transport-Security: max-age=31536000`;
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: strict-origin-when-cross-origin`;
- `X-Frame-Options: SAMEORIGIN`;
- the legacy `X-XSS-Protection: 1; mode=block`.

Each yields to a header your app sends itself, except nosniff, which is always sent. A managed policy takes none of
your account's 20 custom response headers policies.

`hstsIncludeSubdomains: true` adds `includeSubDomains` to HSTS. It builds a custom policy with the same headers (one of
the 20). Pass `responseHeadersPolicy` to use a policy of your own on those behaviors instead; it replaces the whole
set. The policy in use is exposed as `responseHeadersPolicy`: give it to any behavior you add yourself, which gets
none otherwise.

**To adopt.** Upgrade and run `cdk diff`. It shows `ResponseHeadersPolicyId` set on the distribution's default
behavior and on `/_next/static/*` and `/assets/*`, and, with `hstsIncludeSubdomains: true`, a new `SecurityHeaders`
response headers policy. No stateful resource changes. Before deploying, check three things:

- **Framing.** If another site frames your app, send a CSP `frame-ancestors` naming it from the app, or pass a policy
  of your own. `SAMEORIGIN` refuses other sites' frames.
- **Content types.** Your deploy pipeline must upload the static files with their real `Content-Type`, since `nosniff`
  makes a browser refuse a script stored as anything else.
- **Your own policy.** If you already attach one by escape hatch (`ResponseHeadersPolicyId` overrides on the
  distribution), either pass it as `responseHeadersPolicy` and delete the overrides, or delete both and take SSSB's.
  If you keep the overrides, they replace SSSB's policy behavior by behavior.

**Now deletable.** A response headers policy of your own that adds only HSTS, nosniff, a referrer policy and frame
options, and the escape-hatch overrides that attach it.
