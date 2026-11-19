---
'@sssb/cdk': minor
---

### `SssbApp` sends HSTS and safe security headers on every behavior

**Kind.** operator

**Action.** required

**What changed.** The distribution now carries a response headers policy on every behavior, the app's pages and the
static files alike:

- `Strict-Transport-Security: max-age=63072000` (two years; no `includeSubDomains` unless you set
  `hstsIncludeSubdomains: true`; never `preload`);
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: strict-origin-when-cross-origin`;
- `X-Frame-Options: SAMEORIGIN`.

Each is added where the app's response lacks it: a header your app sets itself wins. Pass `responseHeadersPolicy` to
use a policy of your own on every behavior instead. The policy is exposed as `responseHeadersPolicy`.

**To adopt.** Upgrade and run `cdk diff`. It shows a new `SecurityHeaders` response headers policy, and
`ResponseHeadersPolicyId` set on the default behavior and on `/_next/static/*` and `/assets/*`. No stateful resource
changes. Before deploying, check three things:

- **Framing.** If another site frames your app, send a CSP `frame-ancestors` naming it from the app, or pass a policy
  of your own. `SAMEORIGIN` refuses other sites' frames.
- **Content types.** Your deploy pipeline must upload the static files with their real `Content-Type`, since `nosniff`
  makes a browser refuse a script stored as anything else.
- **Your own policy.** If you already attach one by escape hatch (`ResponseHeadersPolicyId` overrides on the
  distribution), either pass it as `responseHeadersPolicy` and delete the overrides, or delete it and take SSSB's. If
  you keep the overrides, they replace SSSB's policy behavior by behavior.

**Now deletable.** A response headers policy of your own that adds only HSTS, nosniff, a referrer policy and frame
options, and the escape-hatch overrides that attach it.
