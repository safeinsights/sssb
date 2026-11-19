# A deployed app's `request.url` is not its public URL

**Priority:** P2 · **Status:** open
**Found by:** the security review of `fix/cdk-forwarded-host-https` (2026-11-19), and corrected while recording it on
`fix/cdk-hsts`: the review said `request.url` names the Function URL's host; the source says the server's own.

## What happens

Behind `SssbApp`, the browser asks for `https://<the app's host>/…`. The Next server sees a request from the Lambda
Web Adapter, on the Function URL, with the Function URL's `Host`. Since `fix/cdk-forwarded-host-https`, the
distribution's forwarded-host function sends the viewer's host as `x-forwarded-host`. The parts that read that header
see the public host: Clerk's request URL, Next's server-action origin check, next-intl's domain redirects.

`request.url` (and `nextUrl`) does not read it. Next 16.4.6 builds the request's `initURL` from its own bind address
when it has one (`next/dist/server/next-server.js`, `attachRequestMeta`:
`${protocol}://${this.fetchHostname}:${this.port}${req.url}`). For a server bound to `0.0.0.0`, as `SssbApp` binds
it (`HOSTNAME=0.0.0.0`), `next/dist/server/lib/start-server.js` hands Next `localhost`. So a deployed app's
`request.url` reads `https://localhost:3000/…` (the protocol from `x-forwarded-proto`). That is read from the source,
not seen on a deployment.

Any absolute URL the app builds from `request.url` is therefore wrong for a visitor: a link in an email, a redirect
it writes by hand, a URL it stores. Relative URLs, and Next's own `redirect('/path')`, are unaffected.

## What reads it in SSSB today

- `packages/kit/src/server-lib/simulator-api.ts` and the starter's `apps/starter/src/app/api/items/route.ts` read
  only the search parameters (`new URL(request.url).searchParams`), which are right.
- `packages/kit/src/adapters/real/clerk-proxy.ts` builds a `NextRequest` from `request.url` to hand to Clerk's
  middleware. Clerk derives its own URL from the forwarded headers it is also given; whether anything in that path
  still uses the URL's host should be checked when this task is picked up.
- Nothing in the kit or the starter builds an absolute public URL today (searched: `request.url`, `nextUrl.origin`,
  `headers.get('host')`).

## The fix, sketched

A kit helper for the app's public origin, so no app has to rediscover this:

- **From the request:** `publicOrigin(request)` reading `x-forwarded-proto` and `x-forwarded-host`. It is safe only
  behind a proxy that overwrites both, as `SssbApp`'s distribution now does. In `pnpm dev`, with no proxy, it falls
  back to the request's own host.
- **From configuration:** a `PUBLIC_ORIGIN` deployment parameter (or `NEXT_PUBLIC_…` if the client needs it), set by
  the deploy to the custom domain at `domains-and-certs`. It is right for anything built outside a request (a job, an
  email batch), where there are no headers.

Probably both: configuration where it is set, the forwarded headers otherwise. A conformance check (or a lint rule)
could then flag `new URL(request.url).origin` and `request.nextUrl.origin` in app code.
