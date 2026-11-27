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
- builds an absolute URL on the request's own URL and lets a visitor or a third party see it. The request is an object
  named `req`, `request`, `nextRequest` (an optional leading `_`) or `<x>.request`, so `session.url` or
  `pullRequest.url` is not one; `<x>.nextUrl` counts on any object, but into a redirect only on one named like a
  request. The rule follows the value through `const` aliases (and a `let` never written again) and through `!`,
  `as`, `satisfies` and `?.`, and reports:
    - the `origin`, `host`, `hostname` or `href` of `new URL(request.url)` or of `request.nextUrl`, by member or
      destructuring, and a string of either: `String(...)`, `.toString()`, `.toJSON()`, `` `${request.nextUrl}` `` or a
      `+` with a string;
    - `new URL(path, request.url)` (or on `request.nextUrl`), and `baseUrl: request.url`;
    - the request's URL, or a string of it, handed to a `redirect`, `rewrite` or `permanentRedirect`:
      `Response.redirect(request.url)`, `NextResponse.redirect(url)` after `const url = request.nextUrl.clone()` and
      `url.pathname = '/x'` (Next's own idiom), `NextResponse.rewrite(new URL(request.url))`;
    - a `request.nextUrl.clone()` that is not a variable's initial value (`Response.redirect(request.nextUrl.clone())`).

    Its path and search parameters are allowed, read or written (`url.searchParams.set(...)`,
    `new URL(request.url).pathname`). The app's own `src/proxy.ts` (or `src/middleware.ts`) is the exception, for
    redirects alone: Next relativizes a same-origin `Location` there however it was built, so the proxy may hand a
    redirect or rewrite the request's URL, a clone of it, a string of either, or a `new URL(path, request.url)` whose
    every use is a redirect's argument or its path and query. Everywhere else a redirect is not relativized: a route
    handler's `NextResponse.redirect(new URL('/en/dashboard', request.url))` sends the visitor to the server's bind
    address.

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
`nextUrl.clone()` with a new path, `new URL('/en/dashboard' + request.nextUrl.search, publicOrigin(request))` (a clone
keeps the app's Next `basePath` and this does not: SSSB's apps set none, and an app that sets one puts it in the path).
Reading `pathname` or `searchParams` from the request's URL is still allowed. Outside a request (a job),
`publicOrigin()` needs the server's `PUBLIC_ORIGIN` (the operator entry of this release). In `pnpm dev`, `publicOrigin`
is the dev server's own origin and `clientAddress` is `undefined`.

**Now deletable.** A helper that builds the app's origin from `x-forwarded-host` and `x-forwarded-proto`, or from
`request.url`; one that takes the client's address from `X-Forwarded-For`, `X-Real-IP` or `CF-Connecting-IP`; and a
`baseUrl: request.url` passed to `sendOrgInvite` or `applyDemoPreset` (pass `publicOrigin(request)`).
