import { expect } from 'vitest'
import { type AppScan, scanApp } from '../../authz/app-exemptions'
import type { CheckContext, CheckImpl } from './types'

/**
 * `authz-mutations`: every mutating route handler (POST/PUT/PATCH/DELETE) in the app must call `authorize(...)`
 * (`@sssb/kit/authz/authorize`). The scan (../../authz/route-scan.ts, applied by ../../authz/app-exemptions.ts
 * `scanApp`) walks every `route.{ts,tsx,js,jsx,mjs}` under the app's WHOLE `src/app`, not only `api/` (Next serves a
 * `route.ts` from anywhere there), and judges each exported mutating handler, read with the TypeScript parser, never
 * the file's text: the handler must reach `authorize` on its own path, or its route must have a justified exemption
 * (the framework's, ../../authz/route-policy.ts, or the app's own `authz-exemptions.mjs`) and the handler must pass
 * that exemption's gate.
 *
 * The test names are fixed (doctor computes them), so every failing handler is reported in ONE assertion, one line
 * each, `<app>: <rel> <VERB> …why`.
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
            // The walk guard: a mis-resolved appDir finds nothing, and every case below would pass vacuously. ROUTE
            // FILES, not mutating ones: an app may legitimately be read-only (a reporting dashboard, an app mid-build).
            const scan = await scanOf(context)
            expect(
                scan.routes.length,
                `no route file under ${scan.root.dir}: the app's route tree was not found, so nothing was checked`,
            ).toBeGreaterThan(0)
        },
        "every mutating handler reaches authorize(...) or passes its exemption's gate": async (context) => {
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
