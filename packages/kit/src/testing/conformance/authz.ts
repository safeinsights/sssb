import { expect } from 'vitest'
import { type AppScan, scanApp } from '../../authz/app-exemptions'
import type { CheckContext, CheckImpl } from './types'

/**
 * `authz-mutations`: every route handler in the app, a read (GET/HEAD/OPTIONS) as well as a mutation
 * (POST/PUT/PATCH/DELETE), and every page, layout and metadata route's export Next calls on the server (a read), must
 * call `authorize(...)` (`@sssb/kit/authz/authorize`). The id predates reads and pages being judged
 * (safeinsights/sssb#103, #221) and is kept, since an app's `optOut` names it. The scan (../../authz/route-scan.ts,
 * applied by ../../authz/app-exemptions.ts `scanApp`) walks every `route.{ts,tsx,js,jsx,mjs}` under the app's WHOLE
 * `src/app`, not only `api/` (Next serves a `route.ts` from anywhere there but a private `_` folder), and judges each exported handler, read
 * with the TypeScript parser, never the file's text: the handler must reach `authorize` on its own path, or its route
 * must have a justified exemption (the framework's, ../../authz/route-policy.ts, or the app's own
 * `authz-exemptions.mjs`) and the handler must pass that exemption's gate. A read handler may instead read nothing:
 * naming nothing from outside itself but inert globals, primitive consts, a few named imports (`NextResponse`, `next/navigation`'s redirects, SSSB's `appMode` and `isSimulated`) and its request, as a liveness probe does. A page's
 * export (`default`, `generateMetadata`, `generateImageMetadata`, `generateSitemaps`, `generateViewport`; a
 * `'use client'` component file is skipped) passes the same three ways, with the page allow-list (the session, the
 * catalog, the locale, a UI ability check) and the client or package components it only renders counted as reading
 * nothing. The same scan judges every Server Action under the app's `src` (each export of a
 * `'use server'` file, each function whose body opens with `'use server'`) like a POST, with no exemption, and fails
 * what Next serves and it cannot read: a `pages` (Pages Router) or root-level `app/` directory, a `route.<ext>` or
 * page file it does not parse, a `'use server'` file outside `src`.
 *
 * The test names are fixed (doctor computes them), so every failing handler is reported in ONE assertion, one line
 * each: `<app>: <rel> <VERB> …why` for a handler, `<app>: <rel> Server Action \`name\` …why` for an action, and a
 * plain sentence for a directory or file the scan cannot read.
 */
const scans = new Map<string, Promise<AppScan>>()
const scanOf = ({ appDir }: CheckContext): Promise<AppScan> => {
    let scan = scans.get(appDir)
    if (!scan) scans.set(appDir, (scan = scanApp(appDir)))
    return scan
}

export const authzMutations: CheckImpl = {
    tests: {
        "the app's src/app is really walked": async (context) => {
            // The walk guard: a mis-resolved appDir finds nothing, and every case below would pass vacuously. It counts
            // route and page FILES, whether or not they export a handler.
            const scan = await scanOf(context)
            expect(
                scan.routes.length + scan.pages.length,
                `no route or page file under ${scan.root.dir}: the app's route tree was not found, so nothing was checked`,
            ).toBeGreaterThan(0)
        },
        "every handler and page export reaches authorize(...), reads nothing, or passes its exemption's gate": async (
            context,
        ) => {
            // Exempt: the gate the reason rests on must hold for THIS handler, so an app route never inherits an
            // exemption on the strength of its path alone, and one verb's gate never covers another's.
            expect((await scanOf(context)).failures).toEqual([])
        },
        "the app's own exemptions are well formed, collide with no framework entry, and are not stale": async (
            context,
        ) => {
            expect((await scanOf(context)).exemptionProblems).toEqual([])
        },
    },
}
