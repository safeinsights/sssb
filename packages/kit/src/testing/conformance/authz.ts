import { expect } from 'vitest'
import { type AppScan, scanApp } from '../../authz/app-exemptions'
import type { CheckContext, CheckImpl } from './types'

/**
 * `authz-mutations`: every route handler in the app, a read (GET/HEAD/OPTIONS) as well as a mutation
 * (POST/PUT/PATCH/DELETE), must call `authorize(...)` (`@sssb/kit/authz/authorize`). The id predates reads being
 * judged (safeinsights/sssb#103) and is kept, since an app's `optOut` names it. The scan (../../authz/route-scan.ts,
 * applied by ../../authz/app-exemptions.ts `scanApp`) walks every `route.{ts,tsx,js,jsx,mjs}` under the app's WHOLE
 * `src/app`, not only `api/` (Next serves a `route.ts` from anywhere there), and judges each exported handler, read
 * with the TypeScript parser, never the file's text: the handler must reach `authorize` on its own path, or its route
 * must have a justified exemption (the framework's, ../../authz/route-policy.ts, or the app's own
 * `authz-exemptions.mjs`) and the handler must pass that exemption's gate. A read handler may instead read nothing:
 * naming nothing from outside itself but inert globals (`Response`, `Date`) and its request, as a liveness probe does. The same scan judges every Server Action under the app's `src` (each export of a
 * `'use server'` file, each function whose body opens with `'use server'`) like a POST, with no exemption, and fails
 * what Next serves and it cannot read: a `pages/api` or root-level `app/` directory, a `route.<ext>` it does not
 * parse, a `'use server'` file outside `src`.
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
            // route FILES, whether or not they export a handler.
            const scan = await scanOf(context)
            expect(
                scan.routes.length,
                `no route file under ${scan.root.dir}: the app's route tree was not found, so nothing was checked`,
            ).toBeGreaterThan(0)
        },
        "every handler reaches authorize(...), reads nothing, or passes its exemption's gate": async (context) => {
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
