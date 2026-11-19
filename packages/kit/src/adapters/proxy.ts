import type { NextFetchEvent, NextProxy, NextRequest } from 'next/server'
import { isSimulated } from './run-mode'

type ProxyResult = Awaited<ReturnType<NextProxy>>

/**
 * The app's request proxy (`src/proxy.ts`, Next's `proxy` file convention) with what SSSB's auth adapter needs around
 * it. In real mode that is Clerk's middleware, without which the Clerk adapter's `auth()` refuses every request: the
 * app's proxy runs inside it (./real/clerk-proxy.ts). In simulated mode the app's proxy runs as it is, and no Clerk
 * code is loaded: the real half is reached only by `import()`, on the first request in real mode.
 *
 * The app's proxy still decides what each path gets (locale routing on pages, nothing on an API route); the app's
 * `config.matcher` must send it every page AND every `/api/...` route, since Clerk needs to see both. Next runs a
 * proxy on the Node.js runtime, so the `import()` here is an ordinary one.
 *
 * Use it as the default export of `src/proxy.ts`:
 *
 *     export default withAuthProxy((request) => locales(request))
 */
export function withAuthProxy(proxy: NextProxy): (request: NextRequest, event: NextFetchEvent) => Promise<ProxyResult> {
    if (isSimulated) return async (request, event) => proxy(request, event)
    let real: Promise<(request: NextRequest, event: NextFetchEvent) => Promise<ProxyResult>> | undefined
    return async (request, event) => {
        // A failed load is forgotten, so the next request tries again rather than failing until a restart.
        real ??= import('./real/clerk-proxy')
            .then(({ withClerk }) => withClerk(proxy))
            .catch((error: unknown) => {
                real = undefined
                throw error
            })
        return (await real)(request, event)
    }
}
