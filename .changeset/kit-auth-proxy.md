---
'@sssb/kit': minor
---

### Real-mode sign-in: `withAuthProxy` runs Clerk's middleware around your proxy

**Kind.** seam

**Action.** required

**What changed.** SSSB's Clerk auth adapter calls Clerk's `auth()`, which refuses any request Clerk's middleware did
not see, and SSSB never ran that middleware, so in real mode every sign-in failed. The new published subpath
`@sssb/kit/adapters/proxy` exports `withAuthProxy(proxy)`: in real mode it runs your proxy inside Clerk's
`clerkMiddleware`, loading it with `import()` on the first request; in simulated mode it runs your proxy as it is and
loads no Clerk code, so `pnpm dev` stays hermetic. It protects no route: each route's `authorize()` still does.

**To adopt.** In `src/proxy.ts`, wrap your proxy and send it every API route as well as your pages. Your proxy still
decides what each path gets; let an API route through untouched:

```ts
import createMiddleware from 'next-intl/middleware'
import { NextResponse } from 'next/server'
import { withAuthProxy } from '@sssb/kit/adapters/proxy'
import { routing } from '@sssb/kit/i18n/routing'

const locales = createMiddleware(routing)

export default withAuthProxy((request) =>
    request.nextUrl.pathname.startsWith('/api') ? NextResponse.next() : locales(request),
)

export const config = {
    matcher: ['/((?!api|_next|_vercel|.*\\..*).*)', '/api/:path*'],
}
```

A proxy that already runs on every path (`matcher: '/:path*'`) keeps its matcher. Clerk's middleware reads the keys the
auth adapter needs (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`). In a deployment, also set `CLERK_JWT_KEY`
to your Clerk instance's JWT public key (PEM, `\n` escapes accepted): Clerk does not read it itself, so the kit passes
it on, and Clerk then checks each session without a call to Clerk's API. A value that is not a 2048-bit RSA public key
stops the proxy at its first request. Clerk is never shown a request's `Authorization` header (users sign in by Clerk's
session cookie), and your proxy and routes still receive it.

**Now deletable.** A wrapper of your own that runs your proxy inside `clerkMiddleware` in real mode: an adapter that
imports `@clerk/nextjs/server` for the proxy, the run-mode check and `import()` in `src/proxy.ts` that load it, and a
test that mocks the run mode to reach it.
