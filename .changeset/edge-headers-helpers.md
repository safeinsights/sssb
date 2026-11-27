---
'@sssb/kit': minor
'@sssb/eslint-plugin': minor
---

### `publicOrigin` and `clientAddress`, and a lint rule against reading the raw request

**Kind.** seam

**Action.** required

**What changed.** A new subpath, `@sssb/kit/adapters/edge-headers`, gives an app the visitor's origin
(`publicOrigin(request)`) and address (`clientAddress(request)`). Behind `SssbApp`, `request.url` and `nextUrl` name the
server's own bind address and port (3000), never the visitor's host, and the first `X-Forwarded-For` entry is whatever the visitor
wrote. A new rule in the app preset, `sssb/no-raw-request-origin`, fails a module under `src/` (tests aside) that:

- reads a forwarded header by name from a request's headers (`request.headers.get('x-forwarded-for')`, `X-Real-IP`,
  `CF-Connecting-IP`, `Forwarded`, `Host`, the other `X-Forwarded-*`);
- takes the `origin`, `host`, `hostname` or `href` of `new URL(request.url)` or of `request.nextUrl`, by member or
  destructuring;
- builds `new URL(path, request.url)` (or on `request.nextUrl`), a redirect included, but in the app's own
  `src/proxy.ts` (or `src/middleware.ts`), where Next relativizes a same-origin redirect or rewrite and nowhere else: a
  route handler's `NextResponse.redirect(new URL('/en/dashboard', request.url))` sends the visitor to the server's bind
  address;
- hands the request's whole URL to a redirect or rewrite (`Response.redirect(request.url)`,
  `NextResponse.redirect(request.nextUrl)`, `NextResponse.rewrite(new URL(request.url))`, `redirect(request.url)`), or
  clones it (`request.nextUrl.clone()`, Next's idiom for a redirect with a new path), but in the app's proxy, as above;
- turns that whole URL into a string: `String(new URL(request.url))`, `.toString()` or `.toJSON()` on it, or
  `` `${request.nextUrl}` ``, in the proxy too;
- does any of these through a variable that holds it: `const url = new URL(request.url)`, then
  `url.pathname = '/x'` and `Response.redirect(url)`, `String(url)`, `url.origin`, `new URL('/x', url)` or
  `baseUrl: url`. Reading `url.pathname` or `url.searchParams` stays allowed;
- passes `baseUrl: request.url`.

**To adopt.** Run `pnpm lint` after upgrading. For each finding:

```ts
import { clientAddress, publicOrigin } from '@sssb/kit/adapters/edge-headers'

// A link a visitor follows: an email, a URL you store.
const link = new URL(`/${locale}/accept-invite`, publicOrigin(request)).toString()

// A rate limit, a lockout, an audit record's "from". undefined means unknown: never a free pass.
const from = clientAddress(request)
```

A redirect needs neither: `redirect('/path')` (from `next/navigation`) and a relative `Location` are right as they are; in
a route handler, write `NextResponse.redirect(new URL('/en/dashboard', publicOrigin(request)))`, and in place of a
`nextUrl.clone()` with a new path, `new URL('/en/dashboard' + request.nextUrl.search, publicOrigin(request))`. Reading
`pathname` or `searchParams` from the request's URL is still allowed. Outside a request (a job), `publicOrigin()` needs
the server's `PUBLIC_ORIGIN` (the operator entry of this release). In `pnpm dev`, `publicOrigin` is the dev server's own
origin and `clientAddress` is `undefined`.

**Now deletable.** A helper that builds the app's origin from `x-forwarded-host` and `x-forwarded-proto`, or from
`request.url`; one that takes the client's address from `X-Forwarded-For`, `X-Real-IP` or `CF-Connecting-IP`; and a
`baseUrl: request.url` passed to `sendOrgInvite` or `applyDemoPreset` (pass `publicOrigin(request)`).
