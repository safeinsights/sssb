import createMiddleware from 'next-intl/middleware'
import { NextResponse } from 'next/server'
import { withAuthProxy } from '@sssb/kit/adapters/proxy'
import { routing } from '@sssb/kit/i18n/routing'

// Next 16 renamed middleware.ts -> proxy.ts. next-intl negotiates the locale on pages; an API route passes through.
// withAuthProxy runs this inside the auth provider's middleware in real mode, which SSSB's auth adapter needs.
const locales = createMiddleware(routing)

export default withAuthProxy((request) =>
    request.nextUrl.pathname.startsWith('/api') ? NextResponse.next() : locales(request),
)

export const config = {
    // Pages for the locale routing, and every API route, since the auth provider's middleware must see those too.
    // Outside `/api`, a path with a dot in it (a static file) is left out, as are `/_next` and `/_vercel`.
    matcher: ['/((?!api|_next|_vercel|.*\\..*).*)', '/api/:path*'],
}
